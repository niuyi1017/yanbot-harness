import type { HarnessErrorCode } from '@yanbot-harness/contracts';

export class CloudError extends Error {
  readonly status: number;
  readonly code: HarnessErrorCode;
  readonly retryable: boolean;
  readonly auditCode: string | undefined;

  constructor(status: number, code: HarnessErrorCode, message: string, retryable = false, auditCode?: string) {
    super(message);
    this.name = 'CloudError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.auditCode = auditCode;
  }
}

export function authenticationFailed(): CloudError {
  return new CloudError(401, 'AUTHENTICATION_FAILED', 'Authentication failed.');
}

export function permissionDenied(): CloudError {
  return new CloudError(403, 'PERMISSION_DENIED', 'Permission denied.');
}

export function admissionPermissionDenied(): CloudError {
  return new CloudError(403, 'PERMISSION_DENIED', 'Permission denied.', false, 'ADMISSION_PERMISSION');
}

export function admissionRejected(reason: 'concurrency' | 'quota'): CloudError {
  return reason === 'concurrency'
    ? new CloudError(
        429,
        'HARNESS_FAILED',
        'The organization has reached its active run limit.',
        true,
        'ADMISSION_CONCURRENCY',
      )
    : new CloudError(
        429,
        'HARNESS_FAILED',
        'The organization has reached its UTC daily run limit.',
        false,
        'ADMISSION_QUOTA',
      );
}

export function resourceNotFound(): CloudError {
  return new CloudError(404, 'HARNESS_FAILED', 'The requested resource does not exist.');
}

export function conflict(message = 'The requested operation conflicts with current state.'): CloudError {
  return new CloudError(409, 'HARNESS_FAILED', message);
}

export function invalidConfiguration(message = 'The request is invalid.'): CloudError {
  return new CloudError(422, 'CONFIGURATION_INVALID', message);
}

export function workspaceLimitExceeded(): CloudError {
  return new CloudError(413, 'CONFIGURATION_INVALID', 'The workspace snapshot exceeds the service limits.');
}
