import pino from 'pino';
import { ValidationRequest, ValidationResult, AlertLogger as IAlertLogger } from '../types';
import { config } from '../utils/config';

const logger = pino({ level: config.logLevel });

// HTTP-based alert logger that calls log-manager service
export class AlertLogger implements IAlertLogger {
  private logManagerUrl: string;

  constructor() {
    this.logManagerUrl = config.logManagerUrl;
  }

  async logBlockedRequest(request: ValidationRequest, result: ValidationResult): Promise<void> {
    try {
      // Redact sensitive values from detections before sending to log-manager
      // Respect per-category redactMatch setting
      const redactedDetections = result.detections?.map((detection) => {
        const shouldRedact = detection.redactMatch !== false;
        const text = shouldRedact
          ? `${detection.text.substring(0, Math.min(4, detection.text.length))}...[REDACTED]`
          : detection.text;

        return {
          text,
          category: detection.category,
        };
      });

      // Create alert by calling log-manager service endpoint
      // DO NOT send anonymizationMap - it contains original sensitive values
      const alertPayload = {
        providerId: request.providerId,
        organizationId: request.organizationId,
        requestId: request.requestId,
        method: request.method,
        path: request.path,
        reason: result.reason,
        problematicContent: result.problematicContent,
        severity: result.severity,
        clientIp: request.clientIp,
        userAgent: request.userAgent,
        detections: redactedDetections,
      };

      const response = await fetch(`${this.logManagerUrl}/logs/alerts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(alertPayload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error), providerId: request.providerId },
        'Failed to log blocked request alert to log-manager'
      );
    }
  }

  async logNonBlockingDetection(
    request: ValidationRequest,
    result: ValidationResult
  ): Promise<void> {
    try {
      // Redact sensitive values from detections before sending to log-manager
      // Respect per-category redactMatch setting
      const redactedDetections = result.detections?.map((detection) => {
        const shouldRedact = detection.redactMatch !== false;
        const text = shouldRedact
          ? `${detection.text.substring(0, Math.min(4, detection.text.length))}...[REDACTED]`
          : detection.text;

        return {
          text,
          category: detection.category,
        };
      });

      // Create low severity alert for non-blocking detections
      // DO NOT send anonymizationMap - it contains original sensitive values
      const alertPayload = {
        providerId: request.providerId,
        organizationId: request.organizationId,
        requestId: request.requestId,
        method: request.method,
        path: request.path,
        reason: result.reason,
        problematicContent: result.problematicContent,
        severity: 'low', // Always low for non-blocking
        clientIp: request.clientIp,
        userAgent: request.userAgent,
        detections: redactedDetections,
      };

      const response = await fetch(`${this.logManagerUrl}/logs/alerts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(alertPayload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error), providerId: request.providerId },
        'Failed to log non-blocking detection to log-manager'
      );
    }
  }

  async close(): Promise<void> {
    // No resources to clean up for HTTP-based logger
  }
}
