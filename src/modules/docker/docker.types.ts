export interface ContainerInfo {
  id: string;
  name: string;
  state: string;
  status: string;
  labels: Record<string, string>;
}

export interface OrchestrationResult {
  success: boolean;
  message: string;
  containersStarted: string[];
  containersStopped: string[];
  containersRemoved: string[];
  errors: string[];
  estimatedTime: number; // Estimated restart time in seconds
}
