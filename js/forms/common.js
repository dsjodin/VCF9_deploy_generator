// Shared option lists, explanations and helpers for the form definitions.
(function () {
  const C = window.Common = {};

  C.list = function (v) {
    return String(v || '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
  };

  C.int = function (v) {
    const n = parseInt(v, 10);
    return isNaN(n) ? v : n;
  };

  C.yes = [{ v: true, l: 'Yes' }, { v: false, l: 'No' }];

  C.deployModel = [
    { v: 'ha', l: 'High Availability (three-node)', d: 'Three NSX Managers, three VCF Operations nodes (master, replica, data) behind a load balancer FQDN, and a multi-node VCF Automation. Recommended for production.' },
    { v: 'simple', l: 'Simple (single node)', d: 'One NSX Manager, one VCF Operations node and a single-node VCF Automation. Lower footprint; suited for labs, PoC or small sites. Cannot be converted to HA by the installer.' },
  ];

  C.opsSize = [
    { v: 'small', l: 'Small', d: '4 vCPU / 16 GB per node. Small environments.' },
    { v: 'medium', l: 'Medium', d: '8 vCPU / 32 GB per node. Common production default.' },
    { v: 'large', l: 'Large', d: '16 vCPU / 48 GB per node. Large fleets.' },
    { v: 'xlarge', l: 'Extra Large', d: '24 vCPU / 128 GB per node. Very large fleets.' },
  ];

  C.collectorSize = [
    { v: 'small', l: 'Small', d: 'Smallest collector footprint. Lab and small environments.' },
    { v: 'standard', l: 'Standard', d: 'Larger collector for production object counts. Workbook default.' },
  ];

  C.vcSize = [
    { v: 'small', l: 'Small', d: 'Up to 100 hosts / 1,000 VMs. Minimum for the management domain in 9.1 (tiny is not allowed).' },
    { v: 'medium', l: 'Medium', d: 'Up to 400 hosts / 4,000 VMs.' },
    { v: 'large', l: 'Large', d: 'Up to 1,000 hosts / 10,000 VMs.' },
    { v: 'xlarge', l: 'X-Large', d: 'Up to 2,500 hosts / 45,000 VMs.' },
  ];

  C.vcStorage = [
    { v: '', l: 'Default', d: 'Default disk size for the chosen appliance size.' },
    { v: 'lstorage', l: 'Large storage', d: 'Larger disks for more stats, events, alarms and tasks retention.' },
    { v: 'xlstorage', l: 'X-Large storage', d: 'Largest disk layout.' },
  ];

  C.nsxSize = [
    { v: 'medium', l: 'Medium', d: '6 vCPU / 24 GB. Default; up to 128 hosts per NSX instance.' },
    { v: 'large', l: 'Large', d: '12 vCPU / 48 GB. Larger environments (more than 128 hosts).' },
    { v: 'xlarge', l: 'Extra Large', d: '24 vCPU / 96 GB. Very large scale.' },
  ];

  C.internalCidr = [
    { v: '198.18.0.0/15', l: '198.18.0.0/15', d: 'Default. Range reserved for benchmark testing; must not be used anywhere else in your network.' },
    { v: '240.0.0.0/15', l: '240.0.0.0/15', d: 'Reserved class E space. Use if 198.18.0.0/15 is in use in your environment.' },
    { v: '250.0.0.0/15', l: '250.0.0.0/15', d: 'Reserved class E space. Alternative if the others collide.' },
  ];

  C.storage = [
    { v: 'vsan-esa', l: 'vSAN ESA', d: 'vSAN Express Storage Architecture. NVMe-based, single-tier storage pools. Requires vSAN ESA certified hardware (ReadyNodes). Recommended for new deployments.' },
    { v: 'vsan-osa', l: 'vSAN OSA', d: 'vSAN Original Storage Architecture with cache + capacity disk groups. Use for hardware not certified for ESA.' },
    { v: 'nfs', l: 'NFS v3', d: 'Principal storage on an NFS v3 export. Requires an NFS VMkernel network and an export reachable from all hosts.' },
    { v: 'fc', l: 'VMFS on Fibre Channel', d: 'Principal storage on a pre-zoned FC LUN visible to all hosts. The VMFS datastore must already be presented to the hosts.' },
  ];

  C.ftt = [
    { v: '1', l: '1 failure (RAID-1 mirroring)', d: 'Tolerates one host failure. Requires at least 3 hosts (4 recommended).' },
    { v: '2', l: '2 failures (RAID-1 mirroring)', d: 'Tolerates two host failures. Requires at least 5 hosts.' },
  ];

  C.rekey = [
    { v: '360', l: '6 hours' },
    { v: '720', l: '12 hours' },
    { v: '1440', l: '1 day', d: 'Default rekey interval.' },
    { v: '4320', l: '3 days' },
    { v: '10080', l: '7 days' },
    { v: 'custom', l: 'Custom (minutes)', d: 'Enter the rekey interval in minutes.' },
  ];

  C.vdsProfile = [
    { v: 'default', l: 'Default (one VDS)', d: 'All traffic (management, vMotion, storage and NSX overlay) on one distributed switch with two uplinks.' },
    { v: 'storage', l: 'Storage traffic separation (two VDS)', d: 'VDS 1: management, vMotion and NSX. VDS 2: vSAN or NFS storage on dedicated NICs.' },
    { v: 'nsx', l: 'NSX traffic separation (two VDS)', d: 'VDS 1: management, vMotion and storage. VDS 2: NSX overlay (host TEP) traffic on dedicated NICs.' },
    { v: 'storage-nsx', l: 'Storage and NSX traffic separation (three VDS)', d: 'VDS 1: management and vMotion. VDS 2: storage. VDS 3: NSX overlay. Needs six physical NICs.' },
    { v: 'custom', l: 'Custom switch configuration', d: 'Choose the number of switches and place each traffic type on a switch yourself.' },
  ];

  C.vdsType = [
    { v: 'uplinks', l: 'VDS uplinks', d: 'Standard independent uplinks with teaming. Works with any physical switch configuration.' },
    { v: 'lag', l: 'VDS LAG (LACP)', d: 'Bundle the NICs into an LACP link aggregation group. Requires matching LACP/MLAG configuration on the top-of-rack switches. Only configurable through the API/JSON, not in the installer UI.' },
  ];

  C.lacpMode = [
    { v: 'ACTIVE', l: 'Active', d: 'The host actively sends LACP negotiation packets. Recommended.' },
    { v: 'PASSIVE', l: 'Passive', d: 'The host only responds to LACP packets. The physical switch must be active.' },
  ];

  C.lacpTimeout = [
    { v: 'SLOW', l: 'Slow (30 s)', d: 'LACPDUs every 30 seconds. Default.' },
    { v: 'FAST', l: 'Fast (1 s)', d: 'LACPDUs every second. Faster failure detection; must match the physical switch.' },
  ];

  C.lagLb = [
    ['SOURCE_AND_DESTINATION_IP_AND_TCP_UDP_PORT_AND_VLAN', 'Source and destination IP, TCP/UDP port and VLAN', 'Default. Best distribution of flows across LAG members.'],
    ['SOURCE_AND_DESTINATION_IP_AND_TCP_UDP_PORT', 'Source and destination IP and TCP/UDP port'],
    ['SOURCE_AND_DESTINATION_IP_AND_VLAN', 'Source and destination IP and VLAN'],
    ['SOURCE_AND_DESTINATION_IP', 'Source and destination IP'],
    ['SOURCE_AND_DESTINATION_MAC', 'Source and destination MAC'],
    ['SOURCE_AND_DESTINATION_TCP_UDP_PORT', 'Source and destination TCP/UDP port'],
    ['DESTINATION_IP_AND_TCP_UDP_PORT_AND_VLAN', 'Destination IP, TCP/UDP port and VLAN'],
    ['SOURCE_IP_AND_TCP_UDP_PORT_AND_VLAN', 'Source IP, TCP/UDP port and VLAN'],
    ['DESTINATION_IP_AND_TCP_UDP_PORT', 'Destination IP and TCP/UDP port'],
    ['SOURCE_IP_AND_TCP_UDP_PORT', 'Source IP and TCP/UDP port'],
    ['DESTINATION_IP_AND_VLAN', 'Destination IP and VLAN'],
    ['SOURCE_IP_AND_VLAN', 'Source IP and VLAN'],
    ['DESTINATION_TCP_UDP_PORT', 'Destination TCP/UDP port'],
    ['SOURCE_TCP_UDP_PORT', 'Source TCP/UDP port'],
    ['DESTINATION_IP', 'Destination IP'],
    ['SOURCE_IP', 'Source IP'],
    ['DESTINATION_MAC', 'Destination MAC'],
    ['SOURCE_MAC', 'Source MAC'],
    ['VLAN', 'VLAN'],
    ['SOURCE_PORT_ID', 'Source port ID'],
  ].map(([v, l, d]) => ({ v, l, d }));

  C.pgTeaming = [
    { v: 'loadbalance_loadbased', l: 'Route based on physical NIC load', d: 'Default and recommended. Starts like originating port ID and moves flows when an uplink exceeds 75% utilisation. No physical switch configuration needed.' },
    { v: 'loadbalance_srcid', l: 'Route based on originating virtual port', d: 'Each virtual port is pinned to one uplink. Simple and predictable; no rebalancing.' },
    { v: 'loadbalance_srcmac', l: 'Route based on source MAC hash', d: 'Uplink chosen by source MAC address hash.' },
    { v: 'loadbalance_ip', l: 'Route based on IP hash', d: 'Requires static EtherChannel on the physical switch. Rarely used with VCF.' },
    { v: 'failover_explicit', l: 'Use explicit failover order', d: 'Always uses the first active uplink; standby uplinks take over on failure. Typical for vSAN with active/standby, and required when the VDS uses a LAG.' },
  ];

  C.nsxMode = [
    { v: 'default', l: 'Apply NSX default (Enhanced Datapath - Standard)', d: 'Uses the default host switch mode configured in NSX Manager, which is Enhanced Datapath Standard (ENS_INTERRUPT).' },
    { v: 'STANDARD', l: 'Standard', d: 'Classic NSX datapath. Use if your NICs or drivers do not support Enhanced Datapath.' },
    { v: 'ENS_INTERRUPT', l: 'Enhanced Datapath - Standard', d: 'Enhanced datapath in interrupt mode. Better performance with no dedicated CPU cores.' },
    { v: 'ENS', l: 'Enhanced Datapath - Dedicated (performance)', d: 'Poll mode with dedicated logical cores for NFV/telco style workloads. Requires compatible NICs and CPU planning.' },
  ];

  C.nsxTeaming = [
    { v: 'LOADBALANCE_SRCID', l: 'Load balance source (port ID)', d: 'Default. TEP traffic distributed across all active uplinks (one TEP per uplink).' },
    { v: 'LOADBALANCE_SRC_MAC', l: 'Load balance source MAC', d: 'Distribution based on source MAC address.' },
    { v: 'FAILOVER_ORDER', l: 'Failover order', d: 'Single active uplink with standby. Required when the NSX switch uses a LAG.' },
  ];

  C.tepMode = [
    { v: 'pool', l: 'Static IP pool', d: 'NSX assigns host TEP addresses from an IP pool you define here. Recommended; no DHCP dependency.' },
    { v: 'dhcp', l: 'DHCP', d: 'Host TEPs get addresses from a DHCP server on the host overlay VLAN. You must provide DHCP (and relay if needed).' },
  ];

  C.vpcType = [
    { v: 'full', l: 'Full Stack VPC', d: 'Complete VPC feature set with NSX overlay. Host TEPs are configured on the cluster.' },
    { v: 'vlan', l: 'VLAN backed VPC', d: 'Essential VPC services without overlay TEPs or TEP management (no host TEP IPs are created).' },
  ];

  C.vpcConnectivity = [
    { v: 'centralized', l: 'Centralized connectivity', d: 'Recommended. No external connection is created by the installer; centralized transit gateway with Edge nodes / VNAs is configured after bring-up in a separate workflow.' },
    { v: 'distributed', l: 'Distributed connectivity', d: 'Installer creates a Distributed Transit Gateway on a VLAN you provide. Does not deploy the VNAs needed for Supervisor services.' },
  ];

  C.storageTypeCommission = { 'vsan-esa': 'VSAN_ESA', 'vsan-osa': 'VSAN', nfs: 'NFS', fc: 'VMFS_FC' };

  C.vdsFields = function (i, nics, vdsCount, nameAuto, api) {
    const A = api || 'dvsSpecs[]';
    const show = s => vdsCount(s) >= i;
    const lag = s => show(s) && s['vds' + i + 'Type'] === 'lag';
    return [
      { type: 'note', text: '<b>Distributed switch ' + i + '</b>', show },
      { id: 'vds' + i + 'Name', label: 'Name', type: 'text', show, auto: nameAuto, help: 'Name of the vSphere Distributed Switch. Leave empty to use the generated name.', api: A + (api ? '.name' : '.dvsName'), maxLen: 80 },
      { id: 'vds' + i + 'Mtu', label: 'MTU', type: 'text', fmt: 'mtu', req: show, def: '9000', show, help: 'MTU of the distributed switch. Must be equal to or larger than the MTU of every network on it. NSX overlay needs at least 1600 (1700+ recommended).', api: A + '.mtu' },
      { id: 'vds' + i + 'Nics', label: 'Physical NICs', type: 'text', req: show, def: nics, show, help: 'Comma separated vmnic names assigned to this switch, in uplink order: the first NIC becomes uplink1, the second uplink2, and so on. Every host must have these vmnics.', hint: 'e.g. vmnic0,vmnic1', api: A + '.vmnicsToUplinks[].id', check: v => C.list(v).every(n => /^vmnic\d+$/.test(n)) || 'Use vmnic names, e.g. vmnic0,vmnic1' },
      { id: 'vds' + i + 'Type', label: 'Uplink type', type: 'select', options: C.vdsType, def: 'uplinks', show, rerender: true, help: 'How the physical NICs connect to the top-of-rack switches.' },
      { id: 'vds' + i + 'LagName', label: 'LAG name', type: 'text', show: lag, maxLen: 16, auto: () => 'vds0' + i + '-lag', help: 'Name of the LACP LAG (max 16 characters). Uplinks are named <code>&lt;lag&gt;-0</code>, <code>&lt;lag&gt;-1</code> ... and port groups use the LAG as their single active uplink.', api: A + '.lagSpecs[].name' },
      { id: 'vds' + i + 'LacpMode', label: 'LACP mode', type: 'select', options: C.lacpMode, show: lag, api: A + '.lagSpecs[].lacpMode', help: 'LACP negotiation mode.' },
      { id: 'vds' + i + 'LagLb', label: 'LAG load balancing', type: 'select', options: C.lagLb, show: lag, api: A + '.lagSpecs[].loadBalancingMode', help: 'Hashing algorithm used to place flows on LAG members. Must be compatible with the physical switch configuration.' },
      { id: 'vds' + i + 'LacpTimeout', label: 'LACP timeout', type: 'select', options: C.lacpTimeout, show: lag, api: A + '.lagSpecs[].lacpTimeoutMode', help: 'LACPDU interval.' },
    ];
  };

  // ---------- "Get from VCF" lookup commands shared by the Day-N forms ----------
  const L = C.lookup = {};
  const q = v => String(v || '').replace(/["'`$\\]/g, '').trim();
  const val = (g, id, ph) => q(g(id)) || ph;
  const SDDC_PH = '<sddc-manager-fqdn>';

  function login(g) {
    const user = val(g, 'sddcUser', 'administrator@vsphere.local');
    return {
      bash: 'SDDC=' + val(g, 'sddcFqdn', SDDC_PH) + '; read -rsp "Password for ' + user + ': " PW; echo; TOKEN=$(curl -sk -X POST "https://$SDDC/v1/tokens" -H "Content-Type: application/json" -d "$(jq -n --arg u \'' + user + '\' --arg p "$PW" \'{username:$u,password:$p}\')" | jq -r .accessToken)',
      pwsh: 'Connect-VcfSddcManagerServer -Server ' + val(g, 'sddcFqdn', SDDC_PH) + ' -User ' + user + ' -Password (Read-Host -AsSecureString "Password for ' + user + '")',
    };
  }
  const get = path => 'curl -sk -H "Authorization: Bearer $TOKEN" "https://$SDDC' + path + '"';
  const vcConnect = g => 'Connect-VIServer -Server ' + val(g, 'vcFqdn', '<vcenter-fqdn>');

  function kv(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    return lines.map(l => {
      const o = {};
      for (const m of l.matchAll(/(\w+)=(\S*)/g)) o[m[1]] = m[2];
      return o;
    }).filter(o => Object.keys(o).length);
  }

  Object.assign(L, { q, val, login, get, vcConnect, kv });

  L.pool = (nameId, idId, note) => (s, g) => {
    const name = val(g, nameId, '<pool-name>');
    const l = login(g);
    return {
      title: 'Get the network pool ID from SDDC Manager',
      note,
      bash: [l.bash, get('/v1/network-pools') + " | jq -r '.elements[] | select(.name==\"" + name + "\") | \"id=\\(.id) name=\\(.name)\"'"],
      pwsh: [l.pwsh, "(Invoke-VcfGetNetworkPool).Elements | Where-Object Name -eq '" + name + "' | ForEach-Object { \"id=$($_.Id) name=$($_.Name)\" }"],
      apply: (text, st) => {
        const r = kv(text).find(o => o.id);
        if (!r) return false;
        st[idId] = r.id;
        return true;
      },
    };
  };

  L.hosts = (rowsId, note) => (s, g) => {
    const fqdns = s[rowsId].map(h => q(h.fqdn)).filter(Boolean);
    const l = login(g);
    const jqSel = fqdns.length ? 'select(.fqdn as $f | ' + JSON.stringify(fqdns) + ' | index($f)) | ' : '';
    const psSel = fqdns.length ? 'Where-Object Fqdn -in @(' + fqdns.map(f => "'" + f + "'").join(',') + ') | ' : '';
    return {
      title: 'Get host IDs from SDDC Manager',
      note: note + ' Only unassigned, usable hosts are listed. Paste the output to fill the IDs; hosts not yet in the table are added.',
      bash: [l.bash, get('/v1/hosts?status=UNASSIGNED_USEABLE') + " | jq -r '.elements[] | " + jqSel + '"\\(.fqdn) \\(.id)"\''],
      pwsh: [l.pwsh, '(Invoke-VcfGetHosts -Status UNASSIGNED_USEABLE).Elements | ' + psSel + 'ForEach-Object { "$($_.Fqdn) $($_.Id)" }'],
      applyHint: 'sfo02-m01-r01-esx01.sfo.rainpole.io 64d34a69-104d-443e-bd92-d949e278da83',
      apply: (text, st) => {
        let n = 0;
        for (const line of text.split(/\r?\n/)) {
          const m = line.trim().match(/^(\S+)\s+([0-9a-fA-F-]{36})$/);
          if (!m) continue;
          const rows = st[rowsId];
          const row = rows.find(h => (h.fqdn || '').trim().toLowerCase() === m[1].toLowerCase());
          if (row) row.id = m[2];
          else {
            const empty = rows.find(h => !(h.fqdn || '').trim());
            if (empty) Object.assign(empty, { fqdn: m[1], id: m[2] });
            else rows.push({ fqdn: m[1], id: m[2] });
          }
          n++;
        }
        return n > 0;
      },
    };
  };


  L.section = (intro, extra) => ({
    id: 'connect', title: 'Lookup command settings',
    intro: intro || 'Optional. This page never connects to VCF. These values are only inserted into the "Get from VCF" commands, which you copy and run yourself in your own shell; paste the output back to fill the form. Not written to the JSON. Commands need <code>curl</code> and <code>jq</code> (bash) or VCF PowerCLI 9.',
    fields: [
      { id: 'sddcFqdn', label: 'SDDC Manager FQDN', type: 'text', fmt: 'fqdn', rerender: true, ph: 'sfo-vcf01.sfo.rainpole.io', help: 'SDDC Manager of the VCF instance.' },
      { id: 'sddcUser', label: 'SDDC Manager user', type: 'text', def: 'administrator@vsphere.local', rerender: true, help: 'User for the API token / PowerCLI connection. The password is prompted when you run the command, never stored here.' },
    ].concat(extra || []),
  });

  // Range checks shared by forms: returns rule issues.
  C.rangeRules = function (out, opts) {
    const { label, gw, start, end, fieldStart, fieldEnd, need, needMsg } = opts;
    const c = Net.parseCidr(gw);
    if (!Net.isIPv4(start) || !Net.isIPv4(end)) return;
    if (Net.toInt(start) > Net.toInt(end)) {
      out.push({ level: 'error', field: fieldEnd, msg: label + ': range end is before range start' });
      return;
    }
    if (c) {
      if (!Net.isUsableHost(start, c)) out.push({ level: 'error', field: fieldStart, msg: label + ': ' + start + ' is not a usable address in ' + c.cidr });
      if (!Net.isUsableHost(end, c)) out.push({ level: 'error', field: fieldEnd, msg: label + ': ' + end + ' is not a usable address in ' + c.cidr });
      if (Net.rangesOverlap(start, end, c.ip, c.ip)) out.push({ level: 'error', field: fieldStart, msg: label + ': range includes the gateway ' + c.ip });
    }
    const n = Net.rangeCount(start, end);
    if (need && n < need) out.push({ level: 'error', field: fieldEnd, msg: label + ': range has ' + n + ' address(es), ' + (needMsg || 'needs at least ' + need) });
    return n;
  };

  C.pw = {
    esx: { min: 8, max: 40, complex: false },
    vcRoot: { min: 15, max: 20 },
    sso: { min: 15, max: 20 },
    sddcRoot: { min: 15, special: '!%@$^#?*' },
    sddcLocal: { min: 12, special: '!%@$^#?*' },
    nsx: { min: 12, norepeat: true },
    fifteen: { min: 15 },
  };
})();
