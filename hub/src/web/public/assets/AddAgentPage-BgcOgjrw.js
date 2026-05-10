import{a as e,i as t,n,u as r}from"./api-M5ChURmU.js";import{i}from"./AuthContext-C3lti5RG.js";import{n as a,t as o}from"./queryKeys-De_A60Nb.js";import{a as s,n as c,r as l,t as u}from"./FormField-LGn8KrAj.js";import{t as d}from"./Card-BcW8Id0s.js";import{t as f}from"./PageTitle-BHG2xmj2.js";import{c as p}from"./formatters-B9FUfMtz.js";import{t as m}from"./CommandBlock-DEIWoGgm.js";var h=r(e(),1),g={target:null,identifier:``,useDefaultBroker:!0,mqttUrl:``,mqttUser:``,mqttPass:``,permissions:{allowUpdates:!0,allowActions:!0},advancedOpen:!1,advanced:{}},_=t(),v=[{id:`docker`,icon:`🐳`,title:`Docker host`,sub:`Linux/macOS box with Docker installed.`,bullets:[`Container metrics`,`Updates + actions`]},{id:`k8s`,icon:`☸`,title:`Kubernetes`,sub:`DaemonSet — one agent per cluster node.`,bullets:[`Pod inventory`,`PV/PVC + events`]},{id:`pve`,icon:`🖥`,title:`Proxmox VE`,sub:`PVE bare-metal install via curl-pipe-bash.`,bullets:[`Guest inventory`,`ZFS, backups, quorum`]},{id:`in-guest`,icon:`📦`,title:`In-guest agent`,sub:`Inside a PVE VM or LXC.`,bullets:[`Auto-correlates to its PVE host`]}];function y({state:e,setState:t}){return(0,_.jsxs)(`div`,{className:`space-y-3`,children:[(0,_.jsx)(`p`,{className:`text-sm text-muted`,children:`Where will this agent run?`}),(0,_.jsx)(`div`,{className:`grid gap-3 sm:grid-cols-2`,children:v.map(n=>{let r=e.target===n.id;return(0,_.jsxs)(`button`,{type:`button`,onClick:()=>t(e=>({...e,target:n.id})),className:[`flex flex-col gap-2 rounded-lg border p-4 text-left transition`,r?`border-info bg-info/10`:`border-border bg-surface hover:border-info/50`].join(` `),"aria-pressed":r,children:[(0,_.jsxs)(`div`,{className:`flex items-center gap-3`,children:[(0,_.jsx)(`span`,{className:`text-2xl`,children:n.icon}),(0,_.jsx)(`span`,{className:`font-semibold`,children:n.title})]}),(0,_.jsx)(`p`,{className:`text-xs text-muted`,children:n.sub}),(0,_.jsx)(`ul`,{className:`mt-1 space-y-0.5 text-xs text-secondary`,children:n.bullets.map(e=>(0,_.jsxs)(`li`,{children:[`• `,e]},e))})]},n.id)})})]})}var b=/^[a-zA-Z0-9._-]{1,63}$/,x=/[\s;`$&|<>"'\\]/;function S(e){return e?b.test(e)?null:`Use letters, digits, dots, dashes, or underscores (max 63 chars). No spaces or shell metacharacters.`:`Required.`}function C(e){return e?x.test(e)?`Contains a disallowed character (whitespace or shell metacharacter).`:/^mqtts?:\/\//.test(e)?null:`Must start with mqtt:// or mqtts://`:null}function w(e){return e&&x.test(e)?`Contains a disallowed character (whitespace or shell metacharacter).`:null}var T={docker:{label:`Host ID`,placeholder:`nas-01`,help:`Unique name for this host. Used in URLs and reports.`},"in-guest":{label:`Host ID`,placeholder:`n8n-vm`,help:`Unique name for this guest. The PVE side identifies it via SMBIOS UUID or hostname/MAC.`},pve:{label:`Host ID`,placeholder:`proxmox-01`,help:"Should match the PVE node hostname (output of `hostname` on the PVE shell)."},k8s:{label:`Cluster name`,placeholder:`homelab-k3s`,help:`Applied to all DaemonSet pods. Used to group nodes in the UI.`}};function E({state:e,setState:t}){let{data:r,isError:i}=a({queryKey:o.agentSetup(),queryFn:()=>n(`/agent-setup`),refetchInterval:!1});(0,h.useEffect)(()=>{i&&e.useDefaultBroker&&t(e=>({...e,useDefaultBroker:!1}))},[i,e.useDefaultBroker,t]);let{data:s}=a({queryKey:o.hosts(),queryFn:()=>n(`/hosts`),refetchInterval:!1}),u=e.target,d=T[u],f=s?.some(t=>t.host_id===e.identifier.trim())??!1,p=e.identifier?S(e.identifier):null,m=e.useDefaultBroker?null:C(e.mqttUrl);return(0,_.jsxs)(`div`,{className:`space-y-5`,children:[(0,_.jsx)(c,{label:d.label,description:d.help,children:(0,_.jsx)(l,{value:e.identifier,onChange:e=>t(t=>({...t,identifier:e.target.value})),placeholder:d.placeholder,autoFocus:!0})}),p&&(0,_.jsx)(`p`,{className:`text-xs text-warning`,children:p}),f&&u!==`k8s`&&(0,_.jsxs)(`p`,{className:`rounded border border-warning/40 bg-warning/10 p-2 text-xs text-warning`,children:[`Host ID '`,e.identifier,`' already exists. Continuing will replace its agent.`]}),(0,_.jsxs)(`div`,{className:`space-y-3`,children:[i&&(0,_.jsx)(`p`,{className:`rounded border border-warning/40 bg-warning/10 p-2 text-xs text-warning`,children:`Could not load broker defaults from the hub. Enter MQTT settings manually below.`}),(0,_.jsxs)(`label`,{className:`flex items-center gap-2 text-sm`,children:[(0,_.jsx)(`input`,{type:`checkbox`,checked:e.useDefaultBroker,onChange:e=>t(t=>({...t,useDefaultBroker:e.target.checked})),disabled:i}),`Use the hub's default broker`]}),(0,_.jsx)(c,{label:`MQTT URL`,children:(0,_.jsx)(l,{value:e.useDefaultBroker?``:e.mqttUrl,onChange:e=>t(t=>({...t,mqttUrl:e.target.value})),placeholder:r?.mqttUrl??`mqtt://hub:1883`,disabled:e.useDefaultBroker})}),m&&(0,_.jsx)(`p`,{className:`text-xs text-warning`,children:m}),(0,_.jsxs)(`div`,{className:`grid gap-3 sm:grid-cols-2`,children:[(0,_.jsx)(c,{label:`MQTT User`,children:(0,_.jsx)(l,{value:e.useDefaultBroker?``:e.mqttUser,onChange:e=>t(t=>({...t,mqttUser:e.target.value})),placeholder:r?.mqttUser??`(none)`,disabled:e.useDefaultBroker})}),(0,_.jsx)(c,{label:`MQTT Password`,children:(0,_.jsx)(l,{value:e.useDefaultBroker?``:e.mqttPass,onChange:e=>t(t=>({...t,mqttPass:e.target.value})),placeholder:r?.mqttPass?`••••••`:`(none)`,disabled:e.useDefaultBroker})})]})]})]})}var D={docker:O(),"in-guest":O(),pve:O(),k8s:[{key:`collectInterval`,label:`Collection interval (min)`,placeholder:`5`},{key:`tz`,label:`Timezone`,placeholder:`UTC`},{key:`diskWarnThreshold`,label:`Disk warning %`,placeholder:`85`},{key:`image`,label:`Image`,placeholder:`andreas404/insightd-agent:latest`}]};function O(){return[{key:`collectInterval`,label:`Collection interval (min)`,placeholder:`5`},{key:`updateCheckCron`,label:`Update-check cron`,placeholder:`0 3 * * *`},{key:`tz`,label:`Timezone`,placeholder:`UTC`},{key:`diskWarnThreshold`,label:`Disk warning %`,placeholder:`85`},{key:`logLines`,label:`Default log lines`,placeholder:`100`},{key:`logMaxLines`,label:`Max log lines`,placeholder:`1000`},{key:`image`,label:`Image`,placeholder:`andreas404/insightd-agent:latest`}]}function k({state:e,setState:t}){let n=e.target,r=n!==`k8s`,i=D[n];return(0,_.jsxs)(`div`,{className:`space-y-5`,children:[(0,_.jsxs)(`div`,{className:`grid gap-3 sm:grid-cols-2`,children:[r&&(0,_.jsx)(c,{label:`Remote updates`,description:`Allow the hub to update this agent remotely.`,children:(0,_.jsxs)(s,{value:e.permissions.allowUpdates?`1`:`0`,onChange:e=>t(t=>({...t,permissions:{...t.permissions,allowUpdates:e.target.value===`1`}})),children:[(0,_.jsx)(`option`,{value:`1`,children:`Enabled`}),(0,_.jsx)(`option`,{value:`0`,children:`Disabled`})]})}),(0,_.jsx)(c,{label:`Container actions`,description:n===`pve`?`Allow start/stop/restart, plus pct/qm guest control.`:`Allow start/stop/restart/remove from the hub UI.`,children:(0,_.jsxs)(s,{value:e.permissions.allowActions?`1`:`0`,onChange:e=>t(t=>({...t,permissions:{...t.permissions,allowActions:e.target.value===`1`}})),children:[(0,_.jsx)(`option`,{value:`1`,children:`Enabled`}),(0,_.jsx)(`option`,{value:`0`,children:`Disabled`})]})})]}),(0,_.jsxs)(`button`,{type:`button`,onClick:()=>t(e=>({...e,advancedOpen:!e.advancedOpen})),className:`text-sm text-info hover:underline`,children:[e.advancedOpen?`▾`:`▸`,` `,e.advancedOpen?`Hide`:`Show`,` advanced (`,i.length,` settings)`]}),e.advancedOpen&&(0,_.jsx)(`div`,{className:`grid gap-3 sm:grid-cols-2`,children:i.map(n=>(0,_.jsxs)(c,{label:n.label,children:[(0,_.jsx)(l,{value:e.advanced[n.key]??``,onChange:e=>t(t=>({...t,advanced:{...t.advanced,[n.key]:e.target.value}})),placeholder:n.placeholder}),n.key===`image`&&e.advanced.image&&w(e.advanced.image)&&(0,_.jsx)(`p`,{className:`text-xs text-warning`,children:w(e.advanced.image)})]},n.key))})]})}function A(e){let{identifier:t,broker:n,permissions:r,advanced:i,image:a}=e,o=`/var/run/docker.sock:/var/run/docker.sock${r.allowUpdates?``:`:ro`}`,s=[`  -e INSIGHTD_HOST_ID=${t} \\`,`  -e INSIGHTD_MQTT_URL=${n.url} \\`,n.user?`  -e INSIGHTD_MQTT_USER=${n.user} \\`:null,n.pass?`  -e INSIGHTD_MQTT_PASS=${n.pass} \\`:null,r.allowUpdates?`  -e INSIGHTD_ALLOW_UPDATES=true \\`:null,r.allowActions?`  -e INSIGHTD_ALLOW_ACTIONS=true \\`:null,j(`INSIGHTD_COLLECT_INTERVAL`,i.collectInterval,`5`),j(`INSIGHTD_UPDATE_CHECK_CRON`,i.updateCheckCron,`0 3 * * *`,{quote:!0}),j(`TZ`,i.tz,`UTC`),j(`INSIGHTD_DISK_WARN_THRESHOLD`,i.diskWarnThreshold,`85`),j(`INSIGHTD_LOG_LINES`,i.logLines,`100`),j(`INSIGHTD_LOG_MAX_LINES`,i.logMaxLines,`1000`)];return[`docker run -d \\`,`  --name insightd-agent \\`,`  --restart unless-stopped \\`,`  -v ${o} \\`,`  -v /:/host:ro \\`,...s.filter(Boolean),`  ${a}`].join(`
`)}function j(e,t,n,r={}){return!t||t===n?null:`  -e ${e}=${r.quote?`"${t}"`:t} \\`}function M(e){let{identifier:t,broker:n,permissions:r,advanced:i}=e,a=[`INSIGHTD_HOST_ID=${t}`,`INSIGHTD_MQTT_URL=${n.url}`];return n.user&&a.push(`INSIGHTD_MQTT_USER=${n.user}`),n.pass&&a.push(`INSIGHTD_MQTT_PASS=${n.pass}`),r.allowUpdates&&a.push(`INSIGHTD_ALLOW_UPDATES=true`),r.allowActions&&a.push(`INSIGHTD_ALLOW_ACTIONS=true`),N(a,`INSIGHTD_COLLECT_INTERVAL`,i.collectInterval,`5`),N(a,`INSIGHTD_UPDATE_CHECK_CRON`,i.updateCheckCron,`0 3 * * *`),N(a,`TZ`,i.tz,`UTC`),N(a,`INSIGHTD_DISK_WARN_THRESHOLD`,i.diskWarnThreshold,`85`),N(a,`INSIGHTD_LOG_LINES`,i.logLines,`100`),N(a,`INSIGHTD_LOG_MAX_LINES`,i.logMaxLines,`1000`),i.image&&a.push(`INSIGHTD_IMAGE=${i.image}`),`curl -fsSL https://get.insightd.org/install | ${a.join(` `)} bash`}function N(e,t,n,r){if(!n||n===r)return;let i=/\s/.test(n);e.push(i?`${t}="${n}"`:`${t}=${n}`)}function P(e){let{identifier:t,broker:n,permissions:r,advanced:i}=e,a=i.image??`andreas404/insightd-agent:latest`,o=[];return n.user&&o.push(F(`INSIGHTD_MQTT_USER`,n.user)),n.pass&&o.push(F(`INSIGHTD_MQTT_PASS`,n.pass)),r.allowActions&&o.push(F(`INSIGHTD_ALLOW_ACTIONS`,`true`,{quote:!0})),i.collectInterval&&i.collectInterval!==`5`&&o.push(F(`INSIGHTD_COLLECT_INTERVAL`,i.collectInterval,{quote:!0})),i.tz&&i.tz!==`UTC`&&o.push(F(`TZ`,i.tz)),i.diskWarnThreshold&&i.diskWarnThreshold!==`85`&&o.push(F(`INSIGHTD_DISK_WARN_THRESHOLD`,i.diskWarnThreshold,{quote:!0})),`kubectl apply -f - <<EOF
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
`}EOF`}`}function F(e,t,n={}){return`- name: ${e}\n  value: ${n.quote?`"${t}"`:t}`}function I({state:e}){let t=e.target,{data:r}=a({queryKey:o.agentSetup(),queryFn:()=>n(`/agent-setup`),refetchInterval:!1}),i={url:e.useDefaultBroker?r?.mqttUrl??``:e.mqttUrl,user:e.useDefaultBroker?r?.mqttUser??``:e.mqttUser,pass:e.useDefaultBroker?r?.mqttPass??``:e.mqttPass},s=e.advanced.image||r?.image||`andreas404/insightd-agent:latest`,c=``;t===`docker`||t===`in-guest`?c=A({identifier:e.identifier,broker:i,permissions:e.permissions,advanced:e.advanced,image:s}):t===`pve`?c=M({identifier:e.identifier,broker:i,permissions:e.permissions,advanced:e.advanced}):t===`k8s`&&(c=P({identifier:e.identifier,broker:i,permissions:{allowActions:e.permissions.allowActions},advanced:{collectInterval:e.advanced.collectInterval,tz:e.advanced.tz,diskWarnThreshold:e.advanced.diskWarnThreshold,image:e.advanced.image}}));let[l,u]=(0,h.useState)(!1),f=t===`in-guest`&&!l,p=a({queryKey:o.agentSetupCheck(t,e.identifier),queryFn:()=>n(`/agent-setup/check?target=${encodeURIComponent(t)}&identifier=${encodeURIComponent(e.identifier)}`),refetchInterval:e=>{let t=e.state.data;return!t||t.status!==`connected`||f&&t.proxmoxLink===null?2e3:!1}}),[g,v]=(0,h.useState)(null);(0,h.useEffect)(()=>{if(t!==`in-guest`){v(null);return}p.data?.status===`connected`&&p.data.proxmoxLink===null&&g===null&&v(Date.now()),p.data?.proxmoxLink!==null&&v(null)},[t,p.data,g]);let y=g!==null&&Date.now()-g>6e4;return(0,_.jsxs)(`div`,{className:`space-y-4`,children:[(0,_.jsxs)(d,{title:`Install command (${t})`,children:[(0,_.jsx)(m,{command:c}),t===`in-guest`&&(0,_.jsx)(`p`,{className:`mt-2 text-xs text-muted`,children:`Auto-correlation to the PVE host completes within ~30s of first heartbeat.`})]}),(0,_.jsx)(d,{title:`Verify`,children:(0,_.jsx)(L,{target:t,identifier:e.identifier,data:p.data,waitingForPveLink:f,onSkipLink:y?()=>u(!0):null})})]})}function L({target:e,identifier:t,data:n,waitingForPveLink:r,onSkipLink:a}){return!n||n.status===`waiting`?(0,_.jsxs)(`div`,{className:`flex items-center gap-2 text-sm text-muted`,children:[(0,_.jsx)(`span`,{className:`inline-block h-2 w-2 animate-pulse rounded-full bg-info`}),`Waiting for agent... First heartbeat usually arrives within 30s.`]}):e===`in-guest`&&r&&n.proxmoxLink===null?(0,_.jsxs)(`div`,{className:`space-y-2 text-sm`,children:[(0,_.jsx)(`div`,{children:`✓ Connected. Waiting for PVE auto-link...`}),a&&(0,_.jsx)(`button`,{type:`button`,onClick:a,className:`text-xs text-info hover:underline`,children:`Skip auto-link check`})]}):e===`in-guest`&&n.proxmoxLink?(0,_.jsxs)(`div`,{className:`text-sm`,children:[`✓ Connected and auto-linked to `,(0,_.jsx)(`strong`,{children:n.proxmoxLink.node}),` / VMID `,(0,_.jsx)(`strong`,{children:n.proxmoxLink.vmid}),` (`,n.proxmoxLink.guestType,`).`,` `,(0,_.jsx)(i,{to:`/hosts/${encodeURIComponent(t)}`,className:`text-info hover:underline`,children:`→ View host page`})]}):e===`pve`?(0,_.jsxs)(`div`,{className:`text-sm`,children:[`✓ Connected. `,n.pveCluster?(0,_.jsxs)(_.Fragment,{children:[`Cluster: `,(0,_.jsx)(`strong`,{children:n.pveCluster}),`.`]}):`Standalone PVE.`,` `,(0,_.jsx)(i,{to:`/hosts/${encodeURIComponent(t)}`,className:`text-info hover:underline`,children:`→ View host page`})]}):e===`k8s`?(0,_.jsxs)(`div`,{className:`text-sm`,children:[`✓ Connected. At least one node has joined the cluster.`,` `,(0,_.jsx)(i,{to:`/hosts`,className:`text-info hover:underline`,children:`→ View Hosts page`})]}):(0,_.jsxs)(`div`,{className:`text-sm`,children:[`✓ Connected. Last heartbeat: `,n.lastSeenAt?p(n.lastSeenAt):`unknown`,`.`,` `,(0,_.jsx)(i,{to:`/hosts/${encodeURIComponent(t)}`,className:`text-info hover:underline`,children:`→ View host page`})]})}var R=[`Target`,`Connection`,`Options`,`Install`];function z(){let[e,t]=(0,h.useState)(g),[n,r]=(0,h.useState)(1),i=n===1?e.target!==null:n===2?e.identifier.trim()!==``&&S(e.identifier)===null&&(e.useDefaultBroker||e.mqttUrl.trim()!==``&&C(e.mqttUrl)===null):n===3?!e.advanced.image||w(e.advanced.image)===null:!1;return(0,_.jsxs)(`div`,{className:`space-y-6`,children:[(0,_.jsx)(f,{children:`Add Agent`}),(0,_.jsx)(B,{current:n,onJump:e=>e<n&&r(e)}),(0,_.jsxs)(`div`,{children:[n===1&&(0,_.jsx)(y,{state:e,setState:t}),n===2&&(0,_.jsx)(E,{state:e,setState:t}),n===3&&(0,_.jsx)(k,{state:e,setState:t}),n===4&&(0,_.jsx)(I,{state:e})]}),(0,_.jsxs)(`div`,{className:`flex justify-between`,children:[(0,_.jsx)(u,{variant:`secondary`,onClick:()=>r(e=>Math.max(1,e-1)),disabled:n===1,children:`← Back`}),n<4?(0,_.jsx)(u,{onClick:()=>r(e=>Math.min(4,e+1)),disabled:!i,children:`Next →`}):(0,_.jsx)(u,{variant:`secondary`,onClick:()=>{window.location.hash=`#/`},children:`Close`})]})]})}function B({current:e,onJump:t}){return(0,_.jsx)(`ol`,{className:`flex items-center gap-2 text-sm`,children:R.map((n,r)=>{let i=r+1,a=i===e,o=i<e,s=o;return(0,_.jsxs)(`li`,{className:`flex items-center gap-2`,children:[(0,_.jsxs)(`button`,{type:`button`,onClick:()=>s&&t(i),disabled:!s,className:[`flex items-center gap-2 rounded-full px-3 py-1`,a?`bg-info text-white`:o?`bg-border text-fg`:`bg-surface text-muted`,s?`cursor-pointer hover:opacity-80`:`cursor-default`].join(` `),children:[(0,_.jsx)(`span`,{className:`font-mono`,children:i}),(0,_.jsx)(`span`,{children:n})]}),r<R.length-1&&(0,_.jsx)(`span`,{className:`text-muted`,children:`→`})]},n)})})}export{z as AddAgentPage};