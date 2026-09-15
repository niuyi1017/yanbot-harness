import Foundation
import Virtualization
import CryptoKit
import Darwin

// Explicit development VM host. Production guest/signing/vendor certification remains a separate gate.
enum HostFailure: Error { case configuration, artifact, unsupported }

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), data.count < 4096 else { exit(1) }
    FileHandle.standardOutput.write(data + Data([10]))
}
func fail(_ stage: String, _ error: Error? = nil) -> Never {
    var value: [String: Any] = ["protocolVersion": 1, "type": "error", "stage": stage]
    if let error = error as NSError? { value["code"] = error.code; value["domain"] = error.domain }
    emit(value) // No descriptions, userInfo, paths, guest console or credentials.
    exit(1)
}

struct Artifact: Decodable { let path: String; let sha256: String }
struct Share: Decodable { let name: String; let path: String; let readOnly: Bool }
struct RuntimeConfiguration: Decodable { let shares: [Share]; let network: Bool }
struct Configuration: Decodable {
    let schemaVersion: Int; let kernel: Artifact; let initrd: Artifact; let runtime: RuntimeConfiguration?
}

func boundedFile(_ name: String, maximum: Int) throws -> Data {
    guard name.hasPrefix("/") else { throw HostFailure.artifact }
    let fd = open(name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { throw HostFailure.artifact }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
          info.st_size > 0, info.st_size <= maximum else { throw HostFailure.artifact }
    var result = Data()
    var buffer = [UInt8](repeating: 0, count: 1024 * 1024)
    while true {
        let count = read(fd, &buffer, buffer.count)
        guard count >= 0 else { throw HostFailure.artifact }
        if count == 0 { break }
        guard result.count + count <= maximum else { throw HostFailure.artifact }
        result.append(contentsOf: buffer.prefix(count))
    }
    guard result.count == info.st_size else { throw HostFailure.artifact }
    return result
}

func snapshot(_ artifact: Artifact, to destination: URL) throws {
    guard artifact.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw HostFailure.artifact }
    let data = try boundedFile(artifact.path, maximum: 256 * 1024 * 1024)
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    guard digest == artifact.sha256 else { throw HostFailure.artifact }
    try data.write(to: destination, options: [.withoutOverwriting])
    try FileManager.default.setAttributes([.posixPermissions: 0o400], ofItemAtPath: destination.path)
}

final class OwnedVM: NSObject, VZVirtualMachineDelegate {
    let vm: VZVirtualMachine
    let root: URL
    let console = Pipe()
    var stopRequested = false
    var stopping = false
    var invalidLease = false
    var lease = Data()
    var consoleBuffer = Data()
    var consoleBytes = 0
    var guestReady = false
    var descendantReady = false
    var transport: VMTransport?
    let runtimeMode: Bool
    var heartbeat = ProcessInfo.processInfo.systemUptime
    var kernelPanic = false
    var stateLease: Int32 = -1

    init(configuration: Configuration, root: URL) throws {
        self.root = root
        runtimeMode = configuration.runtime != nil
        let kernel = root.appendingPathComponent("kernel")
        let initrd = root.appendingPathComponent("initrd")
        try snapshot(configuration.kernel, to: kernel)
        try snapshot(configuration.initrd, to: initrd)
        let boot = VZLinuxBootLoader(kernelURL: kernel)
        boot.initialRamdiskURL = initrd
        boot.commandLine = "console=hvc0 rdinit=/harness-init panic=0"
        let config = VZVirtualMachineConfiguration()
        config.cpuCount = 2
        config.memorySize = (runtimeMode ? 2048 : 512) * 1024 * 1024
        config.bootLoader = boot
        config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        config.socketDevices = [VZVirtioSocketDeviceConfiguration()]
        if let runtime = configuration.runtime {
            guard runtime.shares.count <= 32 else { throw HostFailure.configuration }
            var directories: [String: VZSharedDirectory] = [:]
            for share in runtime.shares {
                guard share.name.range(of: "^(state|workspace-[0-9]{1,2})$", options: .regularExpression) != nil,
                      directories[share.name] == nil, share.path.hasPrefix("/"),
                      share.path != "/", share.path != NSHomeDirectory() else { throw HostFailure.configuration }
                let url = URL(fileURLWithPath: share.path)
                let canonical = url.resolvingSymlinksInPath().standardizedFileURL
                guard canonical.path == url.standardizedFileURL.path,
                      try canonical.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else {
                    throw HostFailure.configuration
                }
                if share.name == "state" {
                    let parent = canonical.deletingLastPathComponent()
                    var info = stat()
                    guard canonical.lastPathComponent == "guest-state", !share.readOnly,
                          lstat(parent.path, &info) == 0, info.st_uid == getuid(),
                          (info.st_mode & S_IFMT) == S_IFDIR, (info.st_mode & 0o077) == 0 else {
                        throw HostFailure.configuration
                    }
                    let lockPath = parent.appendingPathComponent("vm-lease").path
                    stateLease = open(lockPath, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
                    guard stateLease >= 0, fstat(stateLease, &info) == 0, info.st_uid == getuid(),
                          (info.st_mode & S_IFMT) == S_IFREG, (info.st_mode & 0o077) == 0,
                          flock(stateLease, LOCK_EX | LOCK_NB) == 0 else { throw HostFailure.configuration }
                }
                directories[share.name] = VZSharedDirectory(url: canonical, readOnly: share.readOnly)
            }
            let filesystem = VZVirtioFileSystemDeviceConfiguration(tag: "harness-shares")
            filesystem.share = VZMultipleDirectoryShare(directories: directories)
            config.directorySharingDevices = [filesystem]
            if runtime.network {
                let network = VZVirtioNetworkDeviceConfiguration()
                network.attachment = VZNATNetworkDeviceAttachment()
                config.networkDevices = [network]
            }
        }
        let port = VZVirtioConsoleDeviceSerialPortConfiguration()
        port.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: nil, fileHandleForWriting: console.fileHandleForWriting)
        config.serialPorts = [port]
        try config.validate()
        vm = VZVirtualMachine(configuration: config)
        super.init()
        vm.delegate = self
    }

    func run() {
        console.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            DispatchQueue.main.async { self?.readConsole(data) }
        }
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil }
            DispatchQueue.main.async { self?.readLease(data) }
        }
        vm.start { result in
            switch result {
            case .failure(let error): fail("vm-start", error)
            case .success:
                emit(["protocolVersion": 1, "type": "started", "hostPid": getpid(), "boundary": "virtual-machine"])
                if self.stopRequested { self.stop() }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
            if !self.guestReady { self.invalidLease = true; self.stop() }
        }
        if runtimeMode { watchHeartbeat() }
    }

    func watchHeartbeat() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            if self.guestReady && ProcessInfo.processInfo.systemUptime - self.heartbeat > 5 {
                self.stop(); return
            }
            if !self.stopRequested { self.watchHeartbeat() }
        }
    }

    func readConsole(_ data: Data) {
        consoleBytes += data.count
        if consoleBytes > 1024 * 1024 { invalidLease = true; stop(); return }
        consoleBuffer.append(data)
        while let end = consoleBuffer.firstIndex(of: 10) {
            let lineBytes = consoleBuffer.distance(from: consoleBuffer.startIndex, to: end) + 1
            let line = String(decoding: consoleBuffer[..<end], as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            consoleBuffer.removeSubrange(...end)
            if runtimeMode && !kernelPanic && line.contains("Kernel panic - not syncing:") {
                kernelPanic = true
                emit(["protocolVersion": 1, "type": "guest-fault", "kind": "kernel-panic"])
            }
            if line == "HARNESS_RUNTIME_EXIT" && runtimeMode { stop(); return }
            if line == "HARNESS_GUEST_TICK" && runtimeMode {
                consoleBytes -= lineBytes
                heartbeat = ProcessInfo.processInfo.systemUptime; continue
            }
            if line == "HARNESS_GUEST_READY" && guestReady { stop(); return }
            if line == "HARNESS_GUEST_READY" && !guestReady {
                guestReady = true
                heartbeat = ProcessInfo.processInfo.systemUptime
                if runtimeMode {
                    guard let device = vm.socketDevices.first as? VZVirtioSocketDevice else { fail("vsock-device") }
                    let socket = root.appendingPathComponent("http.sock").path
                    do { transport = try VMTransport(path: socket, device: device) }
                    catch { fail("vsock-transport") }
                    emit(["protocolVersion": 1, "type": "transport-ready", "socketPath": socket])
                }
                emit(["protocolVersion": 1, "type": "guest-ready", "guestTarget": "linux-arm64", "certification": "mechanism-only"])
            }
            if line == "HARNESS_DETACHED_READY" && !descendantReady {
                descendantReady = true
                emit(["protocolVersion": 1, "type": "guest-descendant-ready"])
            }
        }
        if consoleBuffer.count > 65536 { invalidLease = true; stop() }
    }

    func readLease(_ data: Data) {
        if data.isEmpty {
            if !lease.isEmpty && lease != Data("stop\n".utf8) { invalidLease = true }
            stop(); return
        }
        lease.append(data)
        if lease.count > 5 || !Data("stop\n".utf8).starts(with: lease) { invalidLease = true; stop() }
        else if lease == Data("stop\n".utf8) { stop() }
    }

    func stop() {
        stopRequested = true
        if stopping { return }
        if vm.state == .stopped { finish(); return }
        if vm.state == .starting { return }
        guard vm.canStop else { fail("vm-not-stoppable") }
        stopping = true
        vm.stop { error in
            guard error == nil, self.vm.state == .stopped else { fail("vm-stop") }
            self.finish()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { fail("vm-stop-timeout") }
    }

    func finish() -> Never {
        guard vm.state == .stopped else { fail("vm-not-stopped") }
        emit(["protocolVersion": 1, "type": "stopped", "state": "stopped", "guestReady": guestReady])
        try? FileManager.default.removeItem(at: root) // Only this invocation's newly created snapshot directory.
        exit(invalidLease ? 1 : 0)
    }
    func guestDidStop(_ virtualMachine: VZVirtualMachine) { finish() }
    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) { fail("vm-error") }
}

@main struct Main {
    static func main() {
        signal(SIGPIPE, SIG_IGN)
        let args = CommandLine.arguments
        if args.count == 2 && args[1] == "--capabilities" {
            emit(["protocolVersion": 1, "type": "capabilities", "virtualizationSupported": VZVirtualMachine.isSupported,
                  "hostTarget": "darwin-arm64", "guestTarget": "linux-arm64", "productionCertified": false])
            return
        }
        guard args.count == 3, ["--validate", "--probe-run"].contains(args[1]) else { fail("arguments") }
        do {
            let bytes = try boundedFile(args[2], maximum: 16384)
            guard let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                  Set(object.keys) == Set(object["runtime"] == nil ? ["schemaVersion", "kernel", "initrd"] :
                    ["schemaVersion", "kernel", "initrd", "runtime"]) else { throw HostFailure.configuration }
            for key in ["kernel", "initrd"] {
                guard let item = object[key] as? [String: Any], Set(item.keys) == Set(["path", "sha256"]) else { throw HostFailure.configuration }
            }
            if let runtime = object["runtime"] {
                guard let runtime = runtime as? [String: Any], Set(runtime.keys) == Set(["shares", "network"]),
                      let shares = runtime["shares"] as? [[String: Any]],
                      shares.allSatisfy({ Set($0.keys) == Set(["name", "path", "readOnly"]) }) else {
                    throw HostFailure.configuration
                }
            }
            let config = try JSONDecoder().decode(Configuration.self, from: bytes)
            guard config.schemaVersion == 1, VZVirtualMachine.isSupported else { throw HostFailure.unsupported }
            // Short private pathname is required by sockaddr_un; never reuse an existing directory.
            let root = URL(fileURLWithPath: "/private/tmp").appendingPathComponent("hvm-" + UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            let owned: OwnedVM
            do { owned = try OwnedVM(configuration: config, root: root) }
            catch { try? FileManager.default.removeItem(at: root); throw error }
            if args[1] == "--validate" {
                emit(["protocolVersion": 1, "type": "configuration-valid", "guestBootTested": false])
                try FileManager.default.removeItem(at: root)
                return
            }
            owned.run()
            withExtendedLifetime(owned) { RunLoop.main.run() }
        } catch { fail("configuration-or-artifact") }
    }
}
