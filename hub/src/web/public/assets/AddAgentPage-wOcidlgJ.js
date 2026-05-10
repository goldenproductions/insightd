import{n as e,s as t,t as n}from"./jsx-runtime-2UHhqg_S.js";import{l as r,r as i,s as a,v as o}from"./index-BZAJ7LeH.js";import{a as s,n as c,r as l,t as u}from"./FormField-pmc8zsE8.js";import{t as d}from"./Card-0V6xixBp.js";import{t as f}from"./PageTitle-C-o3wHxq.js";import{c as p}from"./formatters-Cwk9guQs.js";import{n as m,t as h}from"./docker-ChvCEP1X.js";var g=t(e(),1),_={target:null,identifier:``,useDefaultBroker:!0,mqttUrl:``,mqttUser:``,mqttPass:``,permissions:{allowUpdates:!0,allowActions:!0},advancedOpen:!1,advanced:{}},v=n(),y=[{id:`docker`,icon:`🐳`,title:`Docker host`,sub:`Linux/macOS box with Docker installed.`,bullets:[`Container metrics`,`Updates + actions`]},{id:`k8s`,icon:`☸`,title:`Kubernetes`,sub:`DaemonSet — one agent per cluster node.`,bullets:[`Pod inventory`,`PV/PVC + events`]},{id:`pve`,icon:`🖥`,title:`Proxmox VE`,sub:`PVE bare-metal install via curl-pipe-bash.`,bullets:[`Guest inventory`,`ZFS, backups, quorum`]},{id:`in-guest`,icon:`📦`,title:`In-guest agent`,sub:`Inside a PVE VM or LXC.`,bullets:[`Auto-correlates to its PVE host`]}];function b({state:e,setState:t}){return(0,v.jsxs)(`div`,{className:`space-y-3`,children:[(0,v.jsx)(`p`,{className:`text-sm text-muted`,children:`Where will this agent run?`}),(0,v.jsx)(`div`,{className:`grid gap-3 sm:grid-cols-2`,children:y.map(n=>{let r=e.target===n.id;return(0,v.jsxs)(`button`,{type:`button`,onClick:()=>t(e=>({...e,target:n.id})),className:[`flex flex-col gap-2 rounded-lg border p-4 text-left transition`,r?`border-info bg-info/10`:`border-border bg-surface hover:border-info/50`].join(` `),"aria-pressed":r,children:[(0,v.jsxs)(`div`,{className:`flex items-center gap-3`,children:[(0,v.jsx)(`span`,{className:`text-2xl`,children:n.icon}),(0,v.jsx)(`span`,{className:`font-semibold`,children:n.title})]}),(0,v.jsx)(`p`,{className:`text-xs text-muted`,children:n.sub}),(0,v.jsx)(`ul`,{className:`mt-1 space-y-0.5 text-xs text-secondary`,children:n.bullets.map(e=>(0,v.jsxs)(`li`,{children:[`• `,e]},e))})]},n.id)})})]})}var x=/^[a-zA-Z0-9._-]{1,63}$/,S=/[\s;`$&|<>"'\\]/;function C(e){return e?x.test(e)?null:`Use letters, digits, dots, dashes, or underscores (max 63 chars). No spaces or shell metacharacters.`:`Required.`}function w(e){return e?S.test(e)?`Contains a disallowed character (whitespace or shell metacharacter).`:/^mqtts?:\/\//.test(e)?null:`Must start with mqtt:// or mqtts://`:null}function T(e){return e&&S.test(e)?`Contains a disallowed character (whitespace or shell metacharacter).`:null}var E={docker:{label:`Host ID`,placeholder:`nas-01`,help:`Unique name for this host. Used in URLs and reports.`},"in-guest":{label:`Host ID`,placeholder:`n8n-vm`,help:`Unique name for this guest. The PVE side identifies it via SMBIOS UUID or hostname/MAC.`},pve:{label:`Host ID`,placeholder:`proxmox-01`,help:"Should match the PVE node hostname (output of `hostname` on the PVE shell)."},k8s:{label:`Cluster name`,placeholder:`homelab-k3s`,help:`Applied to all DaemonSet pods. Used to group nodes in the UI.`}};function D({state:e,setState:t}){let{data:n,isError:o}=r({queryKey:i.agentSetup(),queryFn:()=>a(`/agent-setup`),refetchInterval:!1});(0,g.useEffect)(()=>{o&&e.useDefaultBroker&&t(e=>({...e,useDefaultBroker:!1}))},[o,e.useDefaultBroker,t]);let{data:s}=r({queryKey:i.hosts(),queryFn:()=>a(`/hosts`),refetchInterval:!1}),u=e.target,d=E[u],f=s?.some(t=>t.host_id===e.identifier.trim())??!1,p=e.identifier?C(e.identifier):null,m=e.useDefaultBroker?null:w(e.mqttUrl);return(0,v.jsxs)(`div`,{className:`space-y-5`,children:[(0,v.jsx)(c,{label:d.label,description:d.help,children:(0,v.jsx)(l,{value:e.identifier,onChange:e=>t(t=>({...t,identifier:e.target.value})),placeholder:d.placeholder,autoFocus:!0})}),p&&(0,v.jsx)(`p`,{className:`text-xs text-warning`,children:p}),f&&u!==`k8s`&&(0,v.jsxs)(`p`,{className:`rounded border border-warning/40 bg-warning/10 p-2 text-xs text-warning`,children:[`Host ID '`,e.identifier,`' already exists. Continuing will replace its agent.`]}),(0,v.jsxs)(`div`,{className:`space-y-3`,children:[o&&(0,v.jsx)(`p`,{className:`rounded border border-warning/40 bg-warning/10 p-2 text-xs text-warning`,children:`Could not load broker defaults from the hub. Enter MQTT settings manually below.`}),(0,v.jsxs)(`label`,{className:`flex items-center gap-2 text-sm`,children:[(0,v.jsx)(`input`,{type:`checkbox`,checked:e.useDefaultBroker,onChange:e=>t(t=>({...t,useDefaultBroker:e.target.checked})),disabled:o}),`Use the hub's default broker`]}),(0,v.jsx)(c,{label:`MQTT URL`,children:(0,v.jsx)(l,{value:e.useDefaultBroker?``:e.mqttUrl,onChange:e=>t(t=>({...t,mqttUrl:e.target.value})),placeholder:n?.mqttUrl??`mqtt://hub:1883`,disabled:e.useDefaultBroker})}),m&&(0,v.jsx)(`p`,{className:`text-xs text-warning`,children:m}),(0,v.jsxs)(`div`,{className:`grid gap-3 sm:grid-cols-2`,children:[(0,v.jsx)(c,{label:`MQTT User`,children:(0,v.jsx)(l,{value:e.useDefaultBroker?``:e.mqttUser,onChange:e=>t(t=>({...t,mqttUser:e.target.value})),placeholder:n?.mqttUser??`(none)`,disabled:e.useDefaultBroker})}),(0,v.jsx)(c,{label:`MQTT Password`,children:(0,v.jsx)(l,{value:e.useDefaultBroker?``:e.mqttPass,onChange:e=>t(t=>({...t,mqttPass:e.target.value})),placeholder:n?.mqttPass?`••••••`:`(none)`,disabled:e.useDefaultBroker})})]})]})]})}var O={docker:k(),"in-guest":k(),pve:k(),k8s:[{key:`collectInterval`,label:`Collection interval (min)`,placeholder:`5`},{key:`tz`,label:`Timezone`,placeholder:`UTC`},{key:`diskWarnThreshold`,label:`Disk warning %`,placeholder:`85`},{key:`image`,label:`Image`,placeholder:`andreas404/insightd-agent:latest`}]};function k(){return[{key:`collectInterval`,label:`Collection interval (min)`,placeholder:`5`},{key:`updateCheckCron`,label:`Update-check cron`,placeholder:`0 3 * * *`},{key:`tz`,label:`Timezone`,placeholder:`UTC`},{key:`diskWarnThreshold`,label:`Disk warning %`,placeholder:`85`},{key:`logLines`,label:`Default log lines`,placeholder:`100`},{key:`logMaxLines`,label:`Max log lines`,placeholder:`1000`},{key:`image`,label:`Image`,placeholder:`andreas404/insightd-agent:latest`}]}function A({state:e,setState:t}){let n=e.target,r=n!==`k8s`,i=O[n];return(0,v.jsxs)(`div`,{className:`space-y-5`,children:[(0,v.jsxs)(`div`,{className:`grid gap-3 sm:grid-cols-2`,children:[r&&(0,v.jsx)(c,{label:`Remote updates`,description:`Allow the hub to update this agent remotely.`,children:(0,v.jsxs)(s,{value:e.permissions.allowUpdates?`1`:`0`,onChange:e=>t(t=>({...t,permissions:{...t.permissions,allowUpdates:e.target.value===`1`}})),children:[(0,v.jsx)(`option`,{value:`1`,children:`Enabled`}),(0,v.jsx)(`option`,{value:`0`,children:`Disabled`})]})}),(0,v.jsx)(c,{label:`Container actions`,description:n===`pve`?`Allow start/stop/restart, plus pct/qm guest control.`:`Allow start/stop/restart/remove from the hub UI.`,children:(0,v.jsxs)(s,{value:e.permissions.allowActions?`1`:`0`,onChange:e=>t(t=>({...t,permissions:{...t.permissions,allowActions:e.target.value===`1`}})),children:[(0,v.jsx)(`option`,{value:`1`,children:`Enabled`}),(0,v.jsx)(`option`,{value:`0`,children:`Disabled`})]})})]}),(0,v.jsxs)(`button`,{type:`button`,onClick:()=>t(e=>({...e,advancedOpen:!e.advancedOpen})),className:`text-sm text-info hover:underline`,children:[e.advancedOpen?`▾`:`▸`,` `,e.advancedOpen?`Hide`:`Show`,` advanced (`,i.length,` settings)`]}),e.advancedOpen&&(0,v.jsx)(`div`,{className:`grid gap-3 sm:grid-cols-2`,children:i.map(n=>(0,v.jsxs)(c,{label:n.label,children:[(0,v.jsx)(l,{value:e.advanced[n.key]??``,onChange:e=>t(t=>({...t,advanced:{...t.advanced,[n.key]:e.target.value}})),placeholder:n.placeholder}),n.key===`image`&&e.advanced.image&&T(e.advanced.image)&&(0,v.jsx)(`p`,{className:`text-xs text-warning`,children:T(e.advanced.image)})]},n.key))})]})}function j(e){let{identifier:t,broker:n,permissions:r,advanced:i}=e,a=[`INSIGHTD_HOST_ID=${t}`,`INSIGHTD_MQTT_URL=${n.url}`];return n.user&&a.push(`INSIGHTD_MQTT_USER=${n.user}`),n.pass&&a.push(`INSIGHTD_MQTT_PASS=${n.pass}`),r.allowUpdates&&a.push(`INSIGHTD_ALLOW_UPDATES=true`),r.allowActions&&a.push(`INSIGHTD_ALLOW_ACTIONS=true`),M(a,`INSIGHTD_COLLECT_INTERVAL`,i.collectInterval,`5`),M(a,`INSIGHTD_UPDATE_CHECK_CRON`,i.updateCheckCron,`0 3 * * *`),M(a,`TZ`,i.tz,`UTC`),M(a,`INSIGHTD_DISK_WARN_THRESHOLD`,i.diskWarnThreshold,`85`),M(a,`INSIGHTD_LOG_LINES`,i.logLines,`100`),M(a,`INSIGHTD_LOG_MAX_LINES`,i.logMaxLines,`1000`),i.image&&a.push(`INSIGHTD_IMAGE=${i.image}`),`curl -fsSL https://get.insightd.org/install | ${a.join(` `)} bash`}function M(e,t,n,r){if(!n||n===r)return;let i=/\s/.test(n);e.push(i?`${t}="${n}"`:`${t}=${n}`)}function N(e){let{identifier:t,broker:n,permissions:r,advanced:i}=e,a=i.image??`andreas404/insightd-agent:latest`,o=[];return n.user&&o.push(P(`INSIGHTD_MQTT_USER`,n.user)),n.pass&&o.push(P(`INSIGHTD_MQTT_PASS`,n.pass)),r.allowActions&&o.push(P(`INSIGHTD_ALLOW_ACTIONS`,`true`,{quote:!0})),i.collectInterval&&i.collectInterval!==`5`&&o.push(P(`INSIGHTD_COLLECT_INTERVAL`,i.collectInterval,{quote:!0})),i.tz&&i.tz!==`UTC`&&o.push(P(`TZ`,i.tz)),i.diskWarnThreshold&&i.diskWarnThreshold!==`85`&&o.push(P(`INSIGHTD_DISK_WARN_THRESHOLD`,i.diskWarnThreshold,{quote:!0})),`kubectl apply -f - <<EOF
${`---
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
          image: ${a}
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
              value: ${t}
            - name: INSIGHTD_MQTT_URL
              value: ${n.url}
${o.length===0?``:o.map(e=>`            `+e.replace(/\n/g,`
            `)).join(`
`)+`
`}EOF`}`}function P(e,t,n={}){return`- name: ${e}\n  value: ${n.quote?`"${t}"`:t}`}function F({state:e}){let t=e.target,{data:n}=r({queryKey:i.agentSetup(),queryFn:()=>a(`/agent-setup`),refetchInterval:!1}),o={url:e.useDefaultBroker?n?.mqttUrl??``:e.mqttUrl,user:e.useDefaultBroker?n?.mqttUser??``:e.mqttUser,pass:e.useDefaultBroker?n?.mqttPass??``:e.mqttPass},s=e.advanced.image||n?.image||`andreas404/insightd-agent:latest`,c=``;t===`docker`||t===`in-guest`?c=h({identifier:e.identifier,broker:o,permissions:e.permissions,advanced:e.advanced,image:s}):t===`pve`?c=j({identifier:e.identifier,broker:o,permissions:e.permissions,advanced:e.advanced}):t===`k8s`&&(c=N({identifier:e.identifier,broker:o,permissions:{allowActions:e.permissions.allowActions},advanced:{collectInterval:e.advanced.collectInterval,tz:e.advanced.tz,diskWarnThreshold:e.advanced.diskWarnThreshold,image:e.advanced.image}}));let[l,u]=(0,g.useState)(!1),f=t===`in-guest`&&!l,p=r({queryKey:i.agentSetupCheck(t,e.identifier),queryFn:()=>a(`/agent-setup/check?target=${encodeURIComponent(t)}&identifier=${encodeURIComponent(e.identifier)}`),refetchInterval:e=>{let t=e.state.data;return!t||t.status!==`connected`||f&&t.proxmoxLink===null?2e3:!1}}),[_,y]=(0,g.useState)(null);(0,g.useEffect)(()=>{if(t!==`in-guest`){y(null);return}p.data?.status===`connected`&&p.data.proxmoxLink===null&&_===null&&y(Date.now()),p.data?.proxmoxLink!==null&&y(null)},[t,p.data,_]);let b=_!==null&&Date.now()-_>6e4;return(0,v.jsxs)(`div`,{className:`space-y-4`,children:[(0,v.jsxs)(d,{title:`Install command (${t})`,children:[(0,v.jsx)(m,{command:c}),t===`in-guest`&&(0,v.jsx)(`p`,{className:`mt-2 text-xs text-muted`,children:`Auto-correlation to the PVE host completes within ~30s of first heartbeat.`})]}),(0,v.jsx)(d,{title:`Verify`,children:(0,v.jsx)(I,{target:t,identifier:e.identifier,data:p.data,waitingForPveLink:f,onSkipLink:b?()=>u(!0):null})})]})}function I({target:e,identifier:t,data:n,waitingForPveLink:r,onSkipLink:i}){return!n||n.status===`waiting`?(0,v.jsxs)(`div`,{className:`flex items-center gap-2 text-sm text-muted`,children:[(0,v.jsx)(`span`,{className:`inline-block h-2 w-2 animate-pulse rounded-full bg-info`}),`Waiting for agent... First heartbeat usually arrives within 30s.`]}):e===`in-guest`&&r&&n.proxmoxLink===null?(0,v.jsxs)(`div`,{className:`space-y-2 text-sm`,children:[(0,v.jsx)(`div`,{children:`✓ Connected. Waiting for PVE auto-link...`}),i&&(0,v.jsx)(`button`,{type:`button`,onClick:i,className:`text-xs text-info hover:underline`,children:`Skip auto-link check`})]}):e===`in-guest`&&n.proxmoxLink?(0,v.jsxs)(`div`,{className:`text-sm`,children:[`✓ Connected and auto-linked to `,(0,v.jsx)(`strong`,{children:n.proxmoxLink.node}),` / VMID `,(0,v.jsx)(`strong`,{children:n.proxmoxLink.vmid}),` (`,n.proxmoxLink.guestType,`).`,` `,(0,v.jsx)(o,{to:`/hosts/${encodeURIComponent(t)}`,className:`text-info hover:underline`,children:`→ View host page`})]}):e===`pve`?(0,v.jsxs)(`div`,{className:`text-sm`,children:[`✓ Connected. `,n.pveCluster?(0,v.jsxs)(v.Fragment,{children:[`Cluster: `,(0,v.jsx)(`strong`,{children:n.pveCluster}),`.`]}):`Standalone PVE.`,` `,(0,v.jsx)(o,{to:`/hosts/${encodeURIComponent(t)}`,className:`text-info hover:underline`,children:`→ View host page`})]}):e===`k8s`?(0,v.jsxs)(`div`,{className:`text-sm`,children:[`✓ Connected. At least one node has joined the cluster.`,` `,(0,v.jsx)(o,{to:`/hosts`,className:`text-info hover:underline`,children:`→ View Hosts page`})]}):(0,v.jsxs)(`div`,{className:`text-sm`,children:[`✓ Connected. Last heartbeat: `,n.lastSeenAt?p(n.lastSeenAt):`unknown`,`.`,` `,(0,v.jsx)(o,{to:`/hosts/${encodeURIComponent(t)}`,className:`text-info hover:underline`,children:`→ View host page`})]})}var L=[`Target`,`Connection`,`Options`,`Install`];function R(){let[e,t]=(0,g.useState)(_),[n,r]=(0,g.useState)(1),i=n===1?e.target!==null:n===2?e.identifier.trim()!==``&&C(e.identifier)===null&&(e.useDefaultBroker||e.mqttUrl.trim()!==``&&w(e.mqttUrl)===null):n===3?!e.advanced.image||T(e.advanced.image)===null:!1;return(0,v.jsxs)(`div`,{className:`space-y-6`,children:[(0,v.jsx)(f,{children:`Add Agent`}),(0,v.jsx)(z,{current:n,onJump:e=>e<n&&r(e)}),(0,v.jsxs)(`div`,{children:[n===1&&(0,v.jsx)(b,{state:e,setState:t}),n===2&&(0,v.jsx)(D,{state:e,setState:t}),n===3&&(0,v.jsx)(A,{state:e,setState:t}),n===4&&(0,v.jsx)(F,{state:e})]}),(0,v.jsxs)(`div`,{className:`flex justify-between`,children:[(0,v.jsx)(u,{variant:`secondary`,onClick:()=>r(e=>Math.max(1,e-1)),disabled:n===1,children:`← Back`}),n<4?(0,v.jsx)(u,{onClick:()=>r(e=>Math.min(4,e+1)),disabled:!i,children:`Next →`}):(0,v.jsx)(u,{variant:`secondary`,onClick:()=>{window.location.hash=`#/`},children:`Close`})]})]})}function z({current:e,onJump:t}){return(0,v.jsx)(`ol`,{className:`flex items-center gap-2 text-sm`,children:L.map((n,r)=>{let i=r+1,a=i===e,o=i<e,s=o;return(0,v.jsxs)(`li`,{className:`flex items-center gap-2`,children:[(0,v.jsxs)(`button`,{type:`button`,onClick:()=>s&&t(i),disabled:!s,className:[`flex items-center gap-2 rounded-full px-3 py-1`,a?`bg-info text-white`:o?`bg-border text-fg`:`bg-surface text-muted`,s?`cursor-pointer hover:opacity-80`:`cursor-default`].join(` `),children:[(0,v.jsx)(`span`,{className:`font-mono`,children:i}),(0,v.jsx)(`span`,{children:n})]}),r<L.length-1&&(0,v.jsx)(`span`,{className:`text-muted`,children:`→`})]},n)})})}export{R as AddAgentPage};