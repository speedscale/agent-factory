import * as k8s from "@kubernetes/client-node";

export const AGENTS_GROUP = "agents.speedscale.io";
export const AGENTS_VERSION = "v1alpha1";
export const AGENTS_API_VERSION = `${AGENTS_GROUP}/${AGENTS_VERSION}`;

export interface K8sClients {
  kc: k8s.KubeConfig;
  objects: k8s.KubernetesObjectApi;
  /**
   * For status-subresource updates. The high-level `objects.patch()` API
   * targets the main resource path and silently drops the `status` field
   * when the CRD has `subresources: { status: {} }` enabled (which the
   * AgentRun CRD does). CustomObjectsApi exposes
   * `patchNamespacedCustomObjectStatus` which hits the `/status`
   * subresource endpoint correctly.
   */
  customObjects: k8s.CustomObjectsApi;
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
    customObjects: kc.makeApiClient(k8s.CustomObjectsApi),
    watch: new k8s.Watch(kc),
  };
}

export function watchPath(plural: string, namespace?: string): string {
  if (namespace) {
    return `/apis/${AGENTS_GROUP}/${AGENTS_VERSION}/namespaces/${namespace}/${plural}`;
  }
  return `/apis/${AGENTS_GROUP}/${AGENTS_VERSION}/${plural}`;
}
