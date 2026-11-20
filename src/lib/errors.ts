export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Route not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'Request body too large') {
    super(413, 'PAYLOAD_TOO_LARGE', message);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(503, code, message, details);
  }
}

export class GatewayTimeoutError extends AppError {
  constructor(message = 'Workflow did not finish in time', details?: unknown) {
    super(504, 'WORKFLOW_TIMEOUT', message, details);
  }
}
