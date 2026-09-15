import Foundation
import Virtualization
import Darwin

// Private per-instance Unix transport. Only raw bytes cross this layer; no shell or business RPC.
final class VMTransport {
    let listener: Int32
    let source: DispatchSourceRead
    let device: VZVirtioSocketDevice
    var active = 0

    init(path: String, device: VZVirtioSocketDevice) throws {
        self.device = device
        var address = sockaddr_un()
        let bytes = Array(path.utf8) + [0]
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw HostFailure.configuration }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
        listener = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { throw HostFailure.configuration }
        let fd = listener
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0, chmod(path, 0o600) == 0, listen(listener, 32) == 0 else {
            close(listener); throw HostFailure.configuration
        }
        fcntl(listener, F_SETFD, FD_CLOEXEC)
        fcntl(listener, F_SETFL, O_NONBLOCK)
        source = DispatchSource.makeReadSource(fileDescriptor: listener, queue: .main)
        source.setEventHandler { [weak self] in self?.acceptConnections() }
        source.setCancelHandler { close(fd) }
        source.resume()
    }
    deinit { source.cancel() }

    func acceptConnections() {
        while true {
            let peer = accept(listener, nil, nil)
            if peer < 0 { return }
            guard active < 64 else { close(peer); continue }
            fcntl(peer, F_SETFD, FD_CLOEXEC)
            active += 1
            device.connect(toPort: 1024) { result in
                switch result {
                case .failure: close(peer); self.active -= 1
                case .success(let connection):
                    let remote = connection.fileDescriptor
                    let group = DispatchGroup()
                    for (input, output) in [(peer, remote), (remote, peer)] {
                        group.enter()
                        DispatchQueue.global(qos: .utility).async {
                            Self.copy(input, output)
                            shutdown(output, SHUT_WR)
                            group.leave()
                        }
                    }
                    group.notify(queue: .main) {
                        close(peer)
                        withExtendedLifetime(connection) { self.active -= 1 }
                    }
                }
            }
        }
    }
    static func copy(_ input: Int32, _ output: Int32) {
        var buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let count = read(input, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            if count <= 0 { return }
            var offset = 0
            while offset < count {
                let written = buffer.withUnsafeBytes { write(output, $0.baseAddress! + offset, count - offset) }
                if written < 0 && errno == EINTR { continue }
                if written <= 0 { return }
                offset += written
            }
        }
    }
}
