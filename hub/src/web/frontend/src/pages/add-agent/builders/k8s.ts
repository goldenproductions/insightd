export interface K8sCommandInputs {
  identifier: string;                                // cluster name → INSIGHTD_HOST_GROUP
  broker: { url: string; user?: string; pass?: string };
  permissions: { allowActions: boolean };
  advanced: {
    collectInterval?: string;
    tz?: string;
    diskWarnThreshold?: string;
    image?: string;
  };
}

export function buildK8sManifest(i: K8sCommandInputs): string {
  const { identifier, broker, permissions: p, advanced: a } = i;
  const image = a.image ?? 'andreas404/insightd-agent:latest';

  const extraEnv: string[] = [];
  if (broker.user) extraEnv.push(envLiteral('INSIGHTD_MQTT_USER', broker.user));
  if (broker.pass) extraEnv.push(envLiteral('INSIGHTD_MQTT_PASS', broker.pass));
  if (p.allowActions) extraEnv.push(envLiteral('INSIGHTD_ALLOW_ACTIONS', 'true', { quote: true }));
  if (a.collectInterval && a.collectInterval !== '5')
    extraEnv.push(envLiteral('INSIGHTD_COLLECT_INTERVAL', a.collectInterval, { quote: true }));
  if (a.tz && a.tz !== 'UTC')
    extraEnv.push(envLiteral('TZ', a.tz));
  if (a.diskWarnThreshold && a.diskWarnThreshold !== '85')
    extraEnv.push(envLiteral('INSIGHTD_DISK_WARN_THRESHOLD', a.diskWarnThreshold, { quote: true }));

  const manifest = `---
apiVersion: v1
kind: Namespace
metadata:
  name: insightd
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: insightd-agent
  namespace: insightd
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: insightd-agent
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["nodes/metrics", "nodes/stats", "nodes/proxy"]
    verbs: ["get"]
  - apiGroups: ["apps"]
    resources: ["replicasets", "deployments", "statefulsets", "daemonsets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["persistentvolumes", "persistentvolumeclaims", "services"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["get", "list"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: insightd-agent
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: insightd-agent
subjects:
  - kind: ServiceAccount
    name: insightd-agent
    namespace: insightd
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: insightd-agent-lease
  namespace: insightd
rules:
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["get", "create", "update", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: insightd-agent-lease
  namespace: insightd
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: insightd-agent-lease
subjects:
  - kind: ServiceAccount
    name: insightd-agent
    namespace: insightd
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: insightd-agent
  namespace: insightd
spec:
  selector:
    matchLabels:
      app: insightd-agent
  template:
    metadata:
      labels:
        app: insightd-agent
    spec:
      serviceAccountName: insightd-agent
      tolerations:
        - operator: Exists
      containers:
        - name: agent
          image: ${image}
          imagePullPolicy: Always
          env:
            - name: INSIGHTD_RUNTIME
              value: kubernetes
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            - name: NODE_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.hostIP
            - name: INSIGHTD_HOST_ID
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            - name: INSIGHTD_HOST_GROUP
              value: ${identifier}
            - name: INSIGHTD_MQTT_URL
              value: ${broker.url}
${extraEnv.length === 0 ? '' : extraEnv.map(s => '            ' + s.replace(/\n/g, '\n            ')).join('\n') + '\n'}EOF`;

  return `kubectl apply -f - <<EOF
${manifest}`;
}

function envLiteral(name: string, value: string, opts: { quote?: boolean } = {}): string {
  const v = opts.quote ? `"${value}"` : value;
  return `- name: ${name}\n  value: ${v}`;
}
