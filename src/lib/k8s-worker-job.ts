import { readFile } from "node:fs/promises";
import { request } from "node:https";

interface EnvVar {
  name: string;
  value: string;
}

interface JobSpecConfig {
  namespace: string;
  image: string;
  pvcName: string;
  redisUrl: string;
  redisQueueKey: string;
  batchSize: string;
  serviceAccountName?: string;
}

function boolFromEnv(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function loadNamespaceFromServiceAccount(): Promise<string> {
  return readFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace", "utf8").then((raw) => raw.trim());
}

async function loadClusterAuth(): Promise<{ token: string; ca: Buffer }> {
  const [token, ca] = await Promise.all([
    readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8"),
    readFile("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")
  ]);

  return {
    token: token.trim(),
    ca
  };
}

function buildJobName(runName: string): string {
  const suffix = Math.floor(Date.now() / 1000).toString(36);
  return `worker-run-${runName}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 48) + `-${suffix}`;
}

function runQueueEnv(config: JobSpecConfig): EnvVar[] {
  return [
    { name: "RUN_QUEUE_BACKEND", value: "redis" },
    { name: "REDIS_URL", value: config.redisUrl },
    { name: "REDIS_QUEUE_KEY", value: config.redisQueueKey },
    { name: "RUN_QUEUE_BATCH_SIZE", value: config.batchSize }
  ];
}

function buildJobManifest(runName: string, config: JobSpecConfig): Record<string, unknown> {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: buildJobName(runName),
      labels: {
        app: "agent-factory-worker",
        "agent-factory/run": runName
      }
    },
    spec: {
      ttlSecondsAfterFinished: 3600,
      backoffLimit: 1,
      template: {
        metadata: {
          labels: {
            app: "agent-factory-worker",
            "agent-factory/run": runName
          }
        },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: config.serviceAccountName,
          initContainers: [
            {
              name: "create-demo-fixture",
              image: config.image,
              imagePullPolicy: "IfNotPresent",
              command: ["node", "dist/bin/create-demo-fixture.js"],
              volumeMounts: [
                { name: "agent-data", mountPath: "/app/artifacts", subPath: "artifacts" },
                { name: "agent-data", mountPath: "/app/.work", subPath: "work" }
              ]
            }
          ],
          containers: [
            {
              name: "worker",
              image: config.image,
              imagePullPolicy: "IfNotPresent",
              command: [
                "/bin/sh",
                "-lc",
                "PATH=\"/app/.work/demo-fixture/bin:$PATH\" node dist/bin/worker.js --source /app/.work/demo-fixture --once --poll-ms 2000 --claim-ttl-ms 900000"
              ],
              env: runQueueEnv(config),
              volumeMounts: [
                { name: "agent-data", mountPath: "/app/artifacts", subPath: "artifacts" },
                { name: "agent-data", mountPath: "/app/.work", subPath: "work" }
              ]
            }
          ],
          volumes: [
            {
              name: "agent-data",
              persistentVolumeClaim: {
                claimName: config.pvcName
              }
            }
          ]
        }
      }
    }
  };
}

async function postKubernetesJob(namespace: string, manifest: Record<string, unknown>, token: string, ca: Buffer): Promise<void> {
  const body = Buffer.from(JSON.stringify(manifest), "utf8");
  await new Promise<void>((resolve, reject) => {
    const req = request(
      {
        host: "kubernetes.default.svc",
        port: 443,
        method: "POST",
        path: `/apis/batch/v1/namespaces/${namespace}/jobs`,
        ca,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": body.length
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
            return;
          }

          reject(new Error(`failed to create worker job (${res.statusCode ?? 0}): ${text}`));
        });
      }
    );

    req.on("error", (error) => reject(error));
    req.write(body);
    req.end();
  });
}

export async function triggerWorkerJobForRun(runName: string): Promise<void> {
  if (!boolFromEnv(process.env.INTAKE_TRIGGER_WORKER_JOB)) {
    return;
  }

  const namespace =
    process.env.INTAKE_WORKER_JOB_NAMESPACE ?? process.env.POD_NAMESPACE ?? (await loadNamespaceFromServiceAccount());
  const image = process.env.INTAKE_WORKER_JOB_IMAGE;
  const pvcName = process.env.INTAKE_WORKER_JOB_PVC ?? "agent-factory-data";
  const redisUrl = process.env.REDIS_URL ?? "redis://redis:6379";
  const redisQueueKey = process.env.REDIS_QUEUE_KEY ?? "agent-factory:runs:queued";
  const batchSize = process.env.RUN_QUEUE_BATCH_SIZE ?? "20";

  if (!image || image.trim().length === 0) {
    throw new Error("INTAKE_WORKER_JOB_IMAGE must be set when INTAKE_TRIGGER_WORKER_JOB=true");
  }

  const config: JobSpecConfig = {
    namespace,
    image,
    pvcName,
    redisUrl,
    redisQueueKey,
    batchSize,
    serviceAccountName: process.env.INTAKE_WORKER_JOB_SERVICE_ACCOUNT
  };

  const { token, ca } = await loadClusterAuth();
  const manifest = buildJobManifest(runName, config);
  await postKubernetesJob(config.namespace, manifest, token, ca);
}
