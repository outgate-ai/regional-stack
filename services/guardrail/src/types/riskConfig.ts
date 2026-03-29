export type RiskCategory =
  | 'personal_information'
  | 'credentials'
  | 'prompt_injection'
  | 'malicious_content'
  | 'sensitive_data';

export type SeverityLevel = 'low' | 'medium' | 'high' | 'critical';

export interface RiskCategoryConfig {
  severity: SeverityLevel;
  blocking: boolean;
  anonymization: boolean;
  redactMatch: boolean;
}

export interface GuardrailConfig {
  riskCategories: Record<RiskCategory, RiskCategoryConfig>;
}

export interface Detection {
  text: string;
  category: RiskCategory;
}

export interface DetectionResult {
  detections: Detection[];
}

// Default configuration
export const defaultGuardrailConfig: GuardrailConfig = {
  riskCategories: {
    personal_information: {
      severity: 'low',
      blocking: false,
      anonymization: true,
      redactMatch: true,
    },
    credentials: {
      severity: 'low',
      blocking: false,
      anonymization: true,
      redactMatch: true,
    },
    prompt_injection: {
      severity: 'high',
      blocking: true,
      anonymization: false,
      redactMatch: true,
    },
    malicious_content: {
      severity: 'critical',
      blocking: true,
      anonymization: false,
      redactMatch: true,
    },
    sensitive_data: {
      severity: 'medium',
      blocking: true,
      anonymization: false,
      redactMatch: true,
    },
  },
};

// Severity level ordering for comparison
export const severityOrder: Record<SeverityLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function getHighestSeverity(severities: SeverityLevel[]): SeverityLevel {
  if (severities.length === 0) return 'low';

  return severities.reduce((highest, current) => {
    return severityOrder[current] > severityOrder[highest] ? current : highest;
  });
}
