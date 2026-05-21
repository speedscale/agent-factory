import * as k8s from "@kubernetes/client-node";

export const AGENTS_GROUP = "agents.speedscale.io";
export const AGENTS_VERSION = "v1alpha1";
export const AGENTS_API_VERSION = `${AGENTS_GROUP}/${AGENTS_VERSION}`;

export interface K8sClients {
  kc: k8s.KubeConfig;
  objects: k8s.KubernetesObjectApi;
  watch: k8s.Watch;
}

export function loadKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }
  return kc;
}

export function makeClients(kc: k8s.KubeConfig = loadKubeConfig()): K8sClients {
  return {
    kc,
    objects: k8s.KubernetesObjectApi.makeApiClient(kc),
    watch: new k8s.Watch(kc),
  };
}

export function watchPath(plural: string, namespace?: string): string {
  if (namespace) {
    return `/apis/${AGENTS_GROUP}/${AGENTS_VERSION}/namespaces/${namespace}/${plural}`;
  }
  return `/apis/${AGENTS_GROUP}/${AGENTS_VERSION}/${plural}`;
}
