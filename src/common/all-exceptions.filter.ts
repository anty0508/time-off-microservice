import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { DomainErrorCode, DomainException } from './exceptions';

/**
 * Translates any thrown error into a consistent JSON envelope:
 *   { errorCode, message, details?, path, timestamp }
 * Domain exceptions carry a stable `errorCode`; framework HttpExceptions are mapped; everything
 * else becomes a 500 INTERNAL_ERROR with the stack logged (but not leaked to the client).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode: string = DomainErrorCode.INTERNAL_ERROR;
    let message = 'Internal server error';
    let details: unknown;

    if (exception instanceof DomainException) {
      status = exception.getStatus();
      errorCode = exception.errorCode;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (res && typeof res === 'object') {
        const body = res as Record<string, unknown>;
        message = (body.message as string) ?? exception.message;
        // class-validator ValidationPipe failures arrive here as { message: string[] }.
        if (Array.isArray(body.message)) {
          errorCode = DomainErrorCode.VALIDATION_ERROR;
          details = { violations: body.message };
          message = 'Request validation failed';
        }
      }
      if (status === HttpStatus.BAD_REQUEST && errorCode === DomainErrorCode.INTERNAL_ERROR) {
        errorCode = DomainErrorCode.VALIDATION_ERROR;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status}: ${message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json({
      errorCode,
      message,
      ...(details ? { details } : {}),
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
