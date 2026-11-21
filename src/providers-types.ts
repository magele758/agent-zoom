export interface LlmModelConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  maxTokens: number;
}

export interface EmbeddingModelConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  dimensions: number;
}

export interface OcrServiceConfig {
  enabled: boolean;
  endpoint: string;
}

export interface WorkflowServiceConfig {
  enabled: boolean;
  endpoint: string;
  apiKey: string;
}

export interface DomesticPaymentConfig {
  enabled: boolean;
  type: "hupijiao";
  endpoint: string;
  appId: string;
  appSecret: string;
  notifyUrl: string;
  returnUrl: string;
}

export interface GlobalPaymentConfig {
  enabled: boolean;
  type: "lemonsqueezy" | "stripe";
  endpoint: string;
  apiKey: string;
  webhookSecret: string;
  returnUrl: string;
}

export interface DistributionServiceConfig {
  enabled: boolean;
  endpoint: string;
  apiKey: string;
  channels: string[];
}

export interface SystemRuntimeConfig {
  maxConcurrentAgents: number;
  agentLogDir: string;
  protectedPaths: string[];
  patrolStaleDays: number;
  lossKillSwitchMonths: number;
  pmAutoCreateThreshold: number;
}

export interface ProvidersConfig {
  system: SystemRuntimeConfig;
  models: {
    llm: LlmModelConfig;
    embedding: EmbeddingModelConfig;
  };
  services: {
    ocr: OcrServiceConfig;
    workflow: WorkflowServiceConfig;
    payment: {
      domestic: DomesticPaymentConfig;
      global: GlobalPaymentConfig;
    };
    distribution: DistributionServiceConfig;
  };
  updatedAt: string;
}

export interface ProviderHealthEntry {
  id: string;
  name: string;
  category: "system" | "model" | "service";
  status: "ok" | "fallback" | "unconfigured" | "error";
  detail: string;
  latencyMs: number | null;
}

export interface ProvidersHealthReport {
  checkedAt: string;
  overall: "ok" | "degraded";
  entries: ProviderHealthEntry[];
}

export interface SemanticVectorResult {
  vector: number[];
  source: "remote" | "local";
  dimensions: number;
}
