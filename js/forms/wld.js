// SDDC Manager: VI workload domain (DomainCreationSpec) and additional cluster (ClusterCreationSpec),
// each with network pool(s) and host commissioning. Both support multi-rack Layer 3 clusters.
(function () {
  const C = Common;
  const N = Net;
  const { val, login, get, vcConnect, kv } = C.lookup;
  const HOST_ID_PH = '<--ENTER-SDDC-HOST-ID-->';
  const POOL_ID_PH = '<--ENTER-NETWORK-POOL-ID-->';
  const IMAGE_PH = '<--ENTER-CLUSTER-IMAGE-ID-->';
  const DOMAIN_PH = '<--ENTER-DOMAIN-ID-->';
  const DS_PH = '<--ENTER-VSAN-DATASTORE-UUID-->';
  const API = 'computeSpec.clusterSpecs[].networkSpec.vdsSpecs[]';
  const NSXP = 'computeSpec.clusterSpecs[].networkSpec.nsxClusterSpec.nsxTClusterSpec';
  const MAX_RACKS = 8;

  const full = s => s.deployType !== 'infra';
  const isVsan = s => ['vsan-esa', 'vsan-osa', 'vsan-max'].includes(s.storage);
  const compute = s => s.storage === 'vsan-compute';
  const vsanNet = s => isVsan(s) || compute(s);
  const isEsa = s => s.storage === 'vsan-esa' || s.storage === 'vsan-max';
  const nfsNet = s => s.storage === 'nfs' || (s.secondary === 'nfs' && s.storage !== 'nfs');
  const clientNet = s => s.storage === 'vsan-max' && s.secondary === 'client';
  const l3 = s => full(s) && s.clusterType === 'l3';
  const rackCount = s => l3(s) ? Math.min(Math.max(Number(s.rackCount) || 2, 2), MAX_RACKS) : 1;
  const racksOf = s => Array.from({ length: rackCount(s) }, (_, i) => i + 1);
  const rp = r => r > 1 ? 'r' + r + '_' : '';
  const rackSfx = r => r > 1 ? '-r0' + r : '';
  const commission = s => !s.commissioned;
  const createPool = (s, r) => full(s) && commission(s) && s[rp(r || 1) + 'poolMode'] !== 'reuse';
  const STATE = [{ v: 'Active', l: 'Active' }, { v: 'Standby', l: 'Standby' }, { v: 'Unused', l: 'Unused' }];
  const fullStack = s => s.vpcType === 'full';
  const distributed = s => fullStack(s) && s.vpcConn === 'distributed';
  const nsxHA = s => s.nsxModel === 'ha';
  const custom = s => s.vdsProfile === 'custom';
  const sup = s => !!s.supervisor;
  const uuidCheck = v => /^[0-9a-fA-F-]{36}$/.test(v) || { level: 'warn', msg: 'IDs are normally UUIDs' };

  const TRAFFIC = [
    { k: 'mgmt', type: 'MANAGEMENT', label: 'ESX management', pg: 'esx-mgmt', show: () => true },
    { k: 'vmotion', type: 'VMOTION', label: 'vMotion', pg: 'vmotion', show: () => true },
    { k: 'vsan', type: 'VSAN', label: 'vSAN', pg: 'vsan', show: vsanNet },
    { k: 'nfs', type: 'NFS', label: 'NFS', pg: 'nfs', show: nfsNet },
    { k: 'vsanext', type: 'VSAN_EXTERNAL', label: 'vSAN storage client', pg: 'vsan-client', show: clientNet },
  ];
  // network pool networks: key, label, type, shown when
  const POOLNETS = [['vmotion', 'vMotion', 'VMOTION', () => true], ['vsan', 'vSAN', 'VSAN', vsanNet], ['nfs', 'NFS', 'NFS', nfsNet], ['vsanext', 'vSAN storage client', 'VSAN_EXTERNAL', clientNet]];
  // workbook sample numbering: 13<rack><n> VLANs, 10.13.<rack><n>.0/24 subnets
  const NETNUM = { vmotion: 2, vsan: 3, tep: 4, nfs: 5, vsanext: 6 };
  function samples(r, k) {
    const o = r * 10 + NETNUM[k];
    return { vlan: '13' + o, gw: '10.13.' + o + '.1/24', start: '10.13.' + o + '.101', end: '10.13.' + o + (k === 'tep' ? '.132' : '.116') };
  }
  const PROFILE = {
    default: { count: 1, storage: 1, nsx: 1 },
    storage: { count: 2, storage: 2, nsx: 1 },
    nsx: { count: 2, storage: 1, nsx: 2 },
    'storage-nsx': { count: 3, storage: 2, nsx: 3 },
  };
  const vdsCount = s => custom(s) ? Number(s.vdsCount) : PROFILE[s.vdsProfile].count;
  function vdsOf(s, k) {
    if (custom(s)) return Math.min(Number(s['vdsFor_' + k]) || 1, vdsCount(s));
    const p = PROFILE[s.vdsProfile];
    if (k === 'nsx') return p.nsx;
    return k === 'vsan' || k === 'nfs' ? p.storage : 1;
  }
  const domAuto = suffix => (s, g) => g('domainName') ? g('domainName') + suffix : '';
  const clAuto = suffix => (s, g) => g('clusterName') ? g('clusterName') + suffix : '';
  const vdsNameAuto = i => clAuto('-vds0' + i);
  const uplinks = (s, i) => C.list(s['vds' + i + 'Nics']).map((_, n) => 'uplink' + (n + 1));
  const pw = s => !s.autoPw;

  function fqdnField(id, label, ph, help, api, extra) {
    return Object.assign({ id, label, type: 'text', fmt: 'fqdn', req: true, ph, help, api }, extra || {});
  }
  function pwField(id, label, rule, help, api, extra) {
    return Object.assign({ id, label, type: 'password', req: pw, show: pw, pw: rule, help, api }, extra || {});
  }

  function poolNet(r, p, title, on) {
    const x = rp(r) + p;
    const o = samples(r, p);
    const show = st => createPool(st, r) && on(st);
    const stat = st => show(st) && st[x + 'Mode'] !== 'dhcp';
    return [
      { type: 'note', text: '<b>' + title + '</b>', show },
      { id: x + 'Mode', label: 'IP assignment', type: 'select', def: 'static', rerender: true, show, options: [
        { v: 'static', l: 'Static', d: 'SDDC Manager assigns VMkernel IPs from the range below.' },
        { v: 'dhcp', l: 'DHCP', d: 'VMkernel adapters get IPs from a DHCP server on this VLAN. No range needed.' },
      ], help: 'Workbook "IP Assignment" of the network pool network.', api: 'networks[].ipAddressAssignmentMode' },
      { id: x + 'Vlan', label: 'VLAN ID', type: 'text', fmt: 'vlan', req: true, ph: o.vlan, show, help: 'VLAN of this network.', api: 'networks[].vlanId' },
      { id: x + 'Mtu', label: 'MTU', type: 'text', fmt: 'mtu', req: true, def: '9000', show, help: 'MTU of the VMkernel network. 9000 recommended.', api: 'networks[].mtu' },
      { id: x + 'Gw', label: 'Gateway (CIDR notation)', type: 'text', fmt: 'gwcidr', req: true, ph: o.gw, show: stat, help: 'Gateway with prefix length. Subnet and mask are derived.', api: ['networks[].gateway', 'networks[].subnet', 'networks[].mask'] },
      { id: x + 'Start', label: 'IP range start', type: 'text', fmt: 'ipv4', req: true, ph: o.start, show: stat, help: 'First address of the network pool range (one per host).', api: 'networks[].ipPools[].start' },
      { id: x + 'End', label: 'IP range end', type: 'text', fmt: 'ipv4', req: true, ph: o.end, show: stat, help: 'Last address of the network pool range.', api: 'networks[].ipPools[].end' },
    ];
  }

  function trafficFields() {
    const out = [];
    for (const t of TRAFFIC) {
      const show = s => full(s) && t.show(s) && !!s.pgAdvanced;
      out.push(
        { type: 'note', text: '<b>Port group: ' + t.label + '</b>', show },
        { id: 'team_' + t.k, label: 'Load balancing', type: 'select', options: C.pgTeaming, show, help: 'Teaming policy of the port group (ignored on a LAG switch).', api: API + '.portGroupSpecs[].teamingPolicy' },
        { id: 'u1_' + t.k, label: 'uplink1', type: 'select', options: STATE, def: 'Active', show, help: 'Failover order of uplink1. Uplinks 3 and higher are always active.', api: API + '.portGroupSpecs[].activeUplinks' },
        { id: 'u2_' + t.k, label: 'uplink2', type: 'select', options: STATE, def: 'Active', show, help: 'Failover order of uplink2.', api: API + '.portGroupSpecs[].standByUplinks' },
      );
    }
    return out;
  }

  const vds = [1, 2, 3].map(i => C.vdsFields(i, ['vmnic0,vmnic1', 'vmnic2,vmnic3', 'vmnic4,vmnic5'][i - 1], vdsCount, vdsNameAuto(i), API)).flat()
    .map(f => f.id && /Nics$/.test(f.id) ? Object.assign({}, f, { api: 'computeSpec.clusterSpecs[].hostSpecs[].hostNetworkSpec.vmNics[].id' }) : f);

  function layoutText(s) {
    const rows = [];
    for (let i = 1; i <= vdsCount(s); i++) {
      const items = TRAFFIC.filter(t => t.show(s) && vdsOf(s, t.k) === i).map(t => t.label);
      if (vdsOf(s, 'nsx') === i) items.push('NSX');
      rows.push('<b>Switch ' + i + ':</b> ' + (items.join(', ') || '<i>nothing assigned</i>'));
    }
    return rows.join('<br>');
  }

  // Networks entered on the Management Domain tab that have a VLAN or subnet
  function mgmtNets() {
    const f = App.forms.mgmt, s = App.states && App.states.mgmt;
    if (!f || !f.networks || !s) return [];
    return f.networks(s).map(n => ({ label: n.label, vlan: String(n.vlan || '').trim(), cidr: N.isCidr(n.gw) ? N.parseCidr(n.gw) : null }))
      .filter(n => (n.vlan && n.vlan !== '0') || n.cidr);
  }

  function mgmtNote() {
    const list = mgmtNets().map(n => n.label + ': ' + [n.vlan ? 'VLAN ' + n.vlan : '', n.cidr ? n.cidr.network + '/' + n.cidr.prefix : ''].filter(Boolean).join(', '));
    return '<b>Use VLANs and subnets of their own for the workload domain, not those of the management domain.</b> This applies to vMotion, vSAN, NFS and host overlay (TEP) below, and to the ESX management network the hosts are on. Workbook example: management domain 11xx / 10.11.x.0, workload domain sfo-w01 13xx / 10.13.x.0.' +
      (list.length ? '<br>Management Domain tab uses: ' + list.join('; ') + '.' : '');
  }

  // ---------- "Get from VCF" lookups ----------
  const domainLookup = (s, g) => {
    const name = val(g, 'domainName', '<domain-name>');
    const l = login(g);
    return {
      title: 'Get the workload domain ID from SDDC Manager',
      bash: [l.bash, get('/v1/domains') + " | jq -r '.elements[] | select(.name==\"" + name + "\") | \"id=\\(.id) name=\\(.name)\"'"],
      pwsh: [l.pwsh, "(Invoke-VcfGetDomains).Elements | Where-Object Name -eq '" + name + "' | ForEach-Object { \"id=$($_.Id) name=$($_.Name)\" }"],
      apply: (text, st) => {
        const r = kv(text).find(o => o.id);
        if (!r) return false;
        st.domainId = r.id;
        if (r.name && !(st.domainName || '').trim()) st.domainName = r.name;
        return true;
      },
    };
  };

  const imageLookup = (s, g) => {
    const l = login(g);
    return {
      title: 'Get the cluster image ID from SDDC Manager',
      note: 'Lists the cluster images (personalities) in Lifecycle Management &gt; Image Management. When several are listed, the one named like the cluster is used, otherwise the first; edit if needed.',
      bash: [l.bash, get('/v1/personalities') + " | jq -r '.elements[] | \"id=\\(.personalityId) name=\\(.personalityName)\"'"],
      pwsh: [l.pwsh, '(Invoke-VcfGetPersonalities).Elements | ForEach-Object { "id=$($_.PersonalityId) name=$($_.PersonalityName)" }'],
      apply: (text, st) => {
        const rows = kv(text).filter(o => o.id);
        if (!rows.length) return false;
        st.imageId = (rows.find(o => o.name && o.name === g('clusterName')) || rows[0]).id;
        return true;
      },
    };
  };

  const datastoreLookup = (s, g) => {
    const ds = val(g, 'remoteDsName', '<vsan-datastore-name>');
    const vc = val(g, 'vcFqdn', '<vcenter-fqdn>');
    return {
      title: 'Get the vSAN datastore UUID from vCenter',
      note: 'Run against the vCenter that manages the vSAN storage cluster. The UUID is the container ID of the vSAN datastore. The bash variant uses <code>govc</code>.',
      bash: ['export GOVC_URL=' + vc + ' GOVC_USERNAME=administrator@vsphere.local GOVC_INSECURE=1; read -rsp "Password: " GOVC_PASSWORD; echo; export GOVC_PASSWORD',
        'govc datastore.info -json "' + ds + '" | jq -r \'[.. | objects | (.containerId? // .ContainerId?) | select(.)][0] | "uuid=\\(.)"\''],
      pwsh: [vcConnect(g), "$ds = Get-Datastore -Name '" + ds + "'; \"uuid=$($ds.ExtensionData.Info.ContainerId) name=$($ds.Name)\""],
      applyHint: 'uuid=52a3f1c2-8d4e-4b7a-9c1e-0f2d3b4a5c6d',
      apply: (text, st) => {
        const r = kv(text).find(o => o.uuid);
        if (!r) return false;
        st.remoteDsUuid = r.uuid.replace(/^vsan:/, '');
        return true;
      },
    };
  };

  const tzLookup = (s, g) => {
    const url = 'https://' + val(g, 'nsxFqdn', '<nsx-manager-fqdn>') + '/policy/api/v1/infra/sites/default/enforcement-points/default/transport-zones';
    return {
      title: 'Get the transport zone names from NSX Manager',
      note: 'NSX Manager of the workload domain (prompts for the admin password). The first overlay and the first VLAN transport zone are used; edit if NSX has several.',
      bash: ['curl -sk -u admin "' + url + '" | jq -r \'.results[] | "\\(.tz_type) \\(.display_name)"\''],
      pwsh: ['(Invoke-RestMethod -Uri "' + url + '" -Credential (Get-Credential admin) -Authentication Basic -SkipCertificateCheck).results | ForEach-Object { "$($_.tz_type) $($_.display_name)" }'],
      applyHint: 'OVERLAY_BACKED overlay-tz-sfo-w01-nsx01',
      apply: (text, st) => {
        let ov = null, vl = null;
        for (const line of text.split(/\r?\n/)) {
          const m = line.trim().match(/^(OVERLAY\w*|VLAN\w*)\s+(\S.*)$/);
          if (!m) continue;
          if (/^OVERLAY/.test(m[1]) && !ov) ov = m[2];
          if (/^VLAN/.test(m[1]) && !vl) vl = m[2];
        }
        if (ov) st.overlayTz = ov;
        if (vl) st.vlanTz = vl;
        return !!(ov || vl);
      },
    };
  };

  function makeForm(kind) {
    const CL = kind === 'cluster';
    const pre = g => (CL ? g('clusterName') : g('domainName')) || kind;

    const STORAGE = C.storage.slice(0, 2).concat(
      [{ v: 'vsan-max', l: 'vSAN Storage Cluster (vSAN Max)', d: 'Disaggregated vSAN ESA storage cluster that provides storage to other (client) clusters. ESA-certified hosts required.' }],
      CL ? [{ v: 'vsan-compute', l: 'vSAN Compute Cluster (remote datastore)', d: 'No local vSAN datastore: the cluster mounts the datastore of a vSAN storage cluster (vSAN Max or HCI) in the same VCF instance. The hosts still need a vSAN network.' }] : [],
      C.storage.slice(2));

    const poolIdField = r => ({
      id: rp(r) + 'poolId', label: 'Network pool ID', type: 'text', check: uuidCheck, show: commission,
      help: 'ID of the network pool from <code>GET /v1/network-pools</code>. Leave empty to keep a placeholder in the commissioning JSON.', api: 'networkPoolId',
      lookup: C.lookup.pool(rp(r) + 'poolName', rp(r) + 'poolId', 'Run after the network pool is created (file 1), or for an existing pool.'),
    });

    const poolFields = r => [
      { id: rp(r) + 'poolMode', label: 'VCF network pool', type: 'select', def: 'create', rerender: true, show: commission, options: [
        { v: 'create', l: 'Create a new VCF network pool', d: 'Generates the network pool JSON (file 1).' },
        { v: 'reuse', l: 'Re-use an existing VCF network pool', d: 'Hosts are commissioned into an existing pool; no network pool file is generated.' },
      ], help: 'Workbook "VCF Network Pool Type".' },
      { id: rp(r) + 'poolName', label: 'Network pool name', type: 'text', show: commission, auto: (s, g) => { const p = CL ? g('clusterName') : g('domainName'); return p ? p + rackSfx(r) + '-np01' : ''; }, help: 'Name of the SDDC Manager network pool (new or existing).', api: 'name' },
      ...POOLNETS.map(([k, label, , on]) => poolNet(r, k, label, on)).flat(),
    ];

    const hostsField = r => ({
      id: rp(r) + 'hosts', label: r > 1 ? 'Rack ' + r + ' hosts' : 'Hosts', type: 'rows', min: r > 1 ? 1 : 2, max: 64, initial: r > 1 ? 2 : 3, addLabel: 'Add host',
      help: r > 1 ? 'Hosts in rack ' + r + '.' : 'Hosts for the cluster (rack 1 in a Layer 3 multi-rack cluster).',
      lookup: C.lookup.hosts(rp(r) + 'hosts', 'Run after the hosts are commissioned (file 2).'),
      columns: [
        { id: 'fqdn', label: 'Host FQDN', type: 'text', fmt: 'fqdn', req: true, ph: (s, g, i) => 'sfo01-w01-r0' + r + '-esx0' + ((i || 0) + 1) + '.sfo.rainpole.io', help: 'FQDN of the ESX host.', api: 'computeSpec.clusterSpecs[].hostSpecs[].hostName' },
        { id: 'id', label: 'SDDC Manager host ID', type: 'text', help: 'UUID of the commissioned host (GET /v1/hosts?status=UNASSIGNED_USEABLE). Leave empty until the host is commissioned.', api: 'computeSpec.clusterSpecs[].hostSpecs[].id', check: v => /^[0-9a-fA-F-]{36}$/.test(v) || { level: 'warn', msg: 'Host IDs are normally UUIDs' } },
      ],
    });

    const tepFields = (r, on) => {
      const x = rp(r);
      const o = samples(r, 'tep');
      const pool = s => on(s) && s.tepMode === 'pool';
      const range = s => pool(s) && !s[x + 'tepReuse'];
      return [
        Object.assign({ id: x + 'tepVlan', label: 'Host overlay VLAN ID', type: 'text', fmt: 'vlan', req: true, ph: o.vlan, show: on, help: 'VLAN for host TEPs (transport VLAN of the uplink profile).', api: NSXP + '.uplinkProfiles[].transportVlan' },
          CL && r === 1 ? { auto: () => C.from('wld', 'tepVlan'), help: 'VLAN for host TEPs (transport VLAN of the uplink profile). Empty: the host overlay VLAN from the Workload Domain tab (clusters in the same rack normally share it).' } : {}),
        { id: x + 'tepPoolName', label: 'IP pool name', type: 'text', show: pool, auto: clAuto(rackSfx(r) + '-tep01'), pattern: '^[a-zA-Z0-9-_]+$', patternMsg: 'Letters, digits, - and _ only', help: 'Name of the NSX TEP IP pool. To reuse an existing pool, enter its name and tick "Re-use an existing IP pool".', api: NSXP + '.ipAddressPoolsSpec[].name' },
        { id: x + 'tepGw', label: 'Gateway (CIDR notation)', type: 'text', fmt: 'gwcidr', req: range, show: range, ph: o.gw, help: 'TEP subnet gateway with prefix.', api: NSXP + '.ipAddressPoolsSpec[].subnets[].gateway' },
        { id: x + 'tepStart', label: 'IP pool start', type: 'text', fmt: 'ipv4', req: range, show: range, ph: o.start, help: 'First TEP address.', api: NSXP + '.ipAddressPoolsSpec[].subnets[].ipAddressPoolRanges[].start' },
        { id: x + 'tepEnd', label: 'IP pool end', type: 'text', fmt: 'ipv4', req: range, show: range, ph: o.end, help: 'Last TEP address.', api: NSXP + '.ipAddressPoolsSpec[].subnets[].ipAddressPoolRanges[].end' },
        { id: x + 'tepReuse', label: 'Re-use an existing IP pool', type: 'checkbox', show: pool, rerender: true, help: 'Reference an IP pool that already exists in this NSX instance (only the name is sent).' },
        { id: x + 'uplinkProfile', label: 'NSX uplink profile name', type: 'text', show: on, auto: clAuto(rackSfx(r) + '-uplink-profile01'), help: 'Uplink profile created in NSX for the hosts' + (r > 1 ? ' of this rack' : '') + '.', api: NSXP + '.uplinkProfiles[].name' },
        { id: x + 'netProfile', label: 'Network profile name', type: 'text', show: on, auto: clAuto(rackSfx(r) + '-network-profile01'), help: 'SDDC Manager network profile that binds the switch, uplink profile and IP pool' + (r > 1 ? ' for this rack' : '') + '. In a Layer 3 cluster each host references the profile of its rack.', api: 'computeSpec.clusterSpecs[].networkSpec.networkProfiles[].name' },
      ];
    };

    const rackSection = r => ({
      id: 'rack' + r, title: 'Rack ' + r, show: s => rackCount(s) >= r,
      intro: 'Layer 3 rack with its own network pool, hosts and host overlay network. The ESX management VLAN and subnet of the rack are configured on the hosts before commissioning and are not part of the JSON.',
      fields: [
        { type: 'note', text: '<b>Network pool</b>' },
        ...poolFields(r),
        poolIdField(r),
        hostsField(r),
        { type: 'note', text: '<b>Host overlay (TEP)</b>', show: fullStack },
        ...tepFields(r, fullStack),
      ],
    });

    const nsxMode = { id: 'nsxMode', label: 'Host switch operational mode', type: 'select', options: C.nsxMode, def: 'default', show: full, help: 'NSX datapath mode on the hosts.', api: API + '.nsxtSwitchConfig.hostSwitchOperationalMode' };
    const overlayTz = CL
      ? { id: 'overlayTz', label: 'Overlay transport zone name', type: 'text', req: true, show: fullStack, ph: 'overlay-tz-sfo-w01-nsx01', auto: () => C.from('wld', 'overlayTz'), help: 'Existing overlay transport zone of the workload domain NSX instance. Empty: taken from the Workload Domain tab.', api: API + '.nsxtSwitchConfig.transportZones[].name', lookup: tzLookup }
      : { id: 'overlayTz', label: 'Overlay transport zone name', type: 'text', show: s => full(s) && fullStack(s), auto: (s, g) => g('nsxVip') ? 'overlay-tz-' + N.shortName(g('nsxVip')) : '', help: 'NSX overlay transport zone.', api: API + '.nsxtSwitchConfig.transportZones[].name' };
    const vlanTzOn = { id: 'vlanTzOn', label: 'Transport zone type: NSX-VLAN', type: 'checkbox', def: !CL, rerender: true, show: full, help: 'Workbook "Transport Zone Type: NSX-VLAN". Attach a VLAN transport zone to the NSX switch (needed for VLAN-backed segments, Edge uplinks).' };
    const vlanTz = Object.assign({ id: 'vlanTz', label: 'VLAN transport zone name', type: 'text', def: 'nsx-vlan-transportzone-0', show: s => full(s) && s.vlanTzOn, help: 'NSX VLAN transport zone.', api: API + '.nsxtSwitchConfig.transportZones[].name' },
      CL ? { def: undefined, auto: () => C.from('wld', 'vlanTz') || 'nsx-vlan-transportzone-0', help: 'NSX VLAN transport zone. Empty: taken from the Workload Domain tab.', lookup: tzLookup } : {});
    const vpcType = { id: 'vpcType', label: 'VPC network configuration', type: 'select', options: C.vpcType, def: 'full', rerender: true,
      help: CL ? 'VPC network configuration of the workload domain NSX instance. It decides whether the hosts get TEPs: Full Stack VPC = TEPs (host overlay section), VLAN backed VPC (9.1.1) = no TEPs.' : 'NSX VPC model.',
      api: CL ? NSXP + '.overlayVtepSpec' : 'nsxTSpec.vpcSpec.vpcNetworkConfigurationType' };
    const vpcConn = { id: 'vpcConn', label: 'Network connectivity', type: 'select', options: C.vpcConnectivity, def: 'centralized', rerender: true, show: CL ? s => fullStack(s) && sup(s) : fullStack, help: CL ? 'VPC connectivity of the domain. Only used for the Supervisor private CIDR.' : 'External connectivity for VPCs.', api: CL ? undefined : 'nsxTSpec.vpcSpec.dtgwSpec' };

    const t1 = tepFields(1, () => true);

    const sections = [
      C.lookup.section(null, CL ? [
        { id: 'vcFqdn', label: 'vCenter FQDN (vSAN storage cluster)', type: 'text', fmt: 'fqdn', rerender: true, show: compute, ph: 'sfo-w01-vc01.sfo.rainpole.io', auto: () => C.from('wld', 'vcFqdn'), help: 'vCenter of the vSAN storage cluster whose datastore is mounted. Used for the datastore UUID lookup. Empty: the vCenter from the Workload Domain tab.' },
        { id: 'nsxFqdn', label: 'NSX Manager FQDN', type: 'text', fmt: 'fqdn', rerender: true, ph: 'sfo-w01-nsx01.sfo.rainpole.io', auto: () => C.from('wld', 'nsxVip'), help: 'NSX Manager (VIP) of the workload domain. Used for the transport zone lookup. Empty: the NSX VIP from the Workload Domain tab.' },
      ] : []),
      {
        id: 'general', title: 'General',
        fields: [
          CL
            ? { id: 'domainName', label: 'Workload domain name', type: 'text', req: true, ph: 'sfo-w01', rerender: true, auto: () => C.from('wld', 'domainName'), help: 'Existing workload domain the cluster is added to. Used for the domain ID lookup and generated names; not part of the JSON. Empty: taken from the Workload Domain tab.' }
            : { id: 'domainName', label: 'Workload domain name', type: 'text', req: true, ph: 'sfo-w01', pattern: '^[a-zA-Z0-9-]{3,20}$', patternMsg: '3-20 characters: letters, digits and hyphens', help: 'Name of the workload domain in SDDC Manager.', api: 'domainName' },
          CL
            ? { id: 'domainId', label: 'Workload domain ID', type: 'text', check: uuidCheck, help: 'ID of the workload domain from <code>GET /v1/domains</code>. Leave empty to keep a placeholder.', api: 'domainId', lookup: domainLookup }
            : { id: 'deployType', label: 'Deployment type', type: 'select', def: 'full', rerender: true, options: [
              { v: 'full', l: 'Full deployment with cluster', d: 'vCenter, NSX and the first vSphere cluster with hosts, storage and networking.' },
              { v: 'infra', l: 'Deploy infrastructure only', d: 'Shell domain: vCenter and NSX only, no cluster. Add clusters later. Only the domain spec is generated.' },
            ], help: 'Workbook "Deployment Type".', api: 'computeSpec' },
          { id: 'clusterType', label: 'Cluster type', type: 'select', def: 'l2', rerender: true, show: full, options: [
            { v: 'l2', l: 'Single-rack / multi-rack Layer 2', d: 'All hosts share the same VLANs and subnets: one network pool, one TEP pool.' },
            { v: 'l3', l: 'Multi-rack Layer 3', d: 'Hosts in 2 - 8 racks with routed, per-rack networks. Each rack has its own network pool, host overlay VLAN and IP pool, uplink profile and network profile.' },
          ], help: 'Workbook "Deploy a Single-Rack / Multi-Rack Layer 2 Cluster" or Layer 3 multi-rack (sheet "Additional Racks").' },
          { id: 'rackCount', label: 'Number of racks', type: 'select', def: '2', rerender: true, show: l3, options: Array.from({ length: MAX_RACKS - 1 }, (_, i) => ({ v: String(i + 2), l: String(i + 2) })), help: 'Workbook "Number of additional racks" plus rack 1. Rack 1 uses the network pool, hosts and host overlay sections; each additional rack gets its own section.' },
          { id: 'storage', label: 'Principal storage', type: 'select', show: full, options: STORAGE, def: 'vsan-esa', rerender: true, help: 'Workbook "Principal Storage Model" of the ' + (CL ? '' : 'first ') + 'cluster.', api: 'computeSpec.clusterSpecs[].datastoreSpec' },
          { id: 'secondary', label: 'Secondary storage network', type: 'select', show: full, def: 'none', rerender: true, options: [
            { v: 'none', l: 'None' },
            { v: 'nfs', l: 'Secondary NFS storage network', d: 'Adds an NFS VMkernel network (network pool + port group) for mounting additional NFS datastores later. Not available when NFS is the principal storage.' },
            { v: 'client', l: 'vSAN storage client network', d: 'Separate network for vSAN Max client traffic (VSAN_EXTERNAL). Only with vSAN Storage Cluster.' },
          ], help: 'Workbook "Secondary Storage".' },
          { id: 'supervisor', label: 'Enable vSphere Supervisor', type: 'checkbox', def: false, rerender: true, show: full, help: 'Activate a single-zone vSphere Supervisor with NSX VPC networking on the cluster.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec' },
          ...(CL ? [] : [{ id: 'autoPw', label: 'Auto-generate passwords', type: 'checkbox', def: false, rerender: true, help: 'Leave vCenter / NSX passwords out so SDDC Manager generates them. ESX root password is still needed for commissioning.' }]),
          { id: 'noLicense', label: 'Deploy without license keys', type: 'checkbox', def: true, help: 'VCF 9 licenses through VCF Operations; keep enabled unless you use legacy keys.', api: 'deployWithoutLicenseKeys' },
        ],
      },
      {
        id: 'pool', title: 'Network pool', num: true, show: full,
        intro: s => (l3(s) ? '<b>Rack 1.</b> ' : '') + 'vMotion and storage IP pools for the hosts. Created in SDDC Manager before commissioning the hosts.',
        fields: [
          { id: 'commissioned', label: 'Hosts are already commissioned', type: 'checkbox', def: false, rerender: true, help: 'The network pool(s) exist and the hosts are commissioned in SDDC Manager (they have host IDs). Files 1 and 2 are not generated; only the ' + (CL ? 'cluster' : 'domain') + ' spec. Set automatically when an imported spec has host IDs for all hosts.' },
          { type: 'note', kind: 'warn', text: mgmtNote },
        ].concat(poolFields(1)),
      },
      {
        id: 'hosts', title: 'Hosts', num: true, show: full,
        intro: s => (l3(s) ? '<b>Rack 1.</b> ' : '') + 'Hosts to commission and add to the cluster. After commissioning, get the host IDs with <b>Get from VCF</b> or copy them from SDDC Manager.',
        fields: [
          { id: 'esxPw', label: 'ESX root password', type: 'password', req: commission, show: commission, pw: C.pw.esx, help: 'Root password of the hosts, used for commissioning.', api: 'password' },
          poolIdField(1),
          { id: 'skipHcl', label: 'Skip vSAN ESA HCL compatibility pre-check', type: 'checkbox', show: s => isEsa(s) && commission(s), help: 'Bypass vSAN ESA HCL validation during commissioning (hosts without certified disks or when SDDC Manager cannot verify disks).', api: 'skipHclCompatibilityPrecheck' },
          hostsField(1),
        ],
      },
      CL ? null : {
        id: 'vcenter', title: 'vCenter', num: true,
        fields: [
          fqdnField('vcFqdn', 'vCenter FQDN', 'sfo-w01-vc01.sfo.rainpole.io', 'FQDN of the workload domain vCenter. Must resolve to an IP on the management VM network.', 'vcenterSpec.networkDetailsSpec.dnsName'),
          { id: 'vcIp', label: 'vCenter IP address', type: 'text', fmt: 'ipv4', help: 'Optional (deprecated in the API, the FQDN is enough). Workbook value; must match DNS.', api: 'vcenterSpec.networkDetailsSpec.ipAddress' },
          { id: 'vcName', label: 'vCenter VM name', type: 'text', auto: (s, g) => g('vcFqdn') ? N.shortName(g('vcFqdn')) : '', help: 'Virtual machine name of the vCenter appliance.', api: 'vcenterSpec.name' },
          { id: 'datacenter', label: 'Datacenter name', type: 'text', auto: domAuto('-dc01'), help: 'vSphere datacenter object name.', api: 'vcenterSpec.datacenterName' },
          { id: 'vcSize', label: 'vCenter size', type: 'select', options: C.vcSize, def: 'medium', help: 'vCenter appliance size.', api: 'vcenterSpec.vmSize' },
          { id: 'vcStorage', label: 'vCenter storage size', type: 'select', options: C.vcStorage, def: '', help: 'vCenter disk layout.', api: 'vcenterSpec.storageSize' },
          pwField('vcRootPw', 'vCenter root password', C.pw.vcRoot, 'Root password of the vCenter appliance.', 'vcenterSpec.rootPassword'),
          { id: 'ssoDomain', label: 'SSO domain', type: 'text', fmt: 'domain', auto: (s, g) => g('domainName') ? g('domainName') + '.local' : '', help: 'New vCenter SSO domain for this workload domain (administrator@&lt;domain&gt;).', api: 'ssoDomainSpec.ssoDomainName' },
          pwField('ssoPw', 'SSO administrator password', C.pw.sso, 'Password for administrator@&lt;SSO domain&gt;.', 'ssoDomainSpec.ssoDomainPassword'),
        ],
      },
      {
        id: 'cluster', title: 'Cluster and storage', num: true, show: full,
        fields: [
          CL
            ? { id: 'clusterName', label: 'Cluster name', type: 'text', req: true, maxLen: 80, ph: 'sfo-w01-cl02', help: 'Name of the new cluster.', api: 'computeSpec.clusterSpecs[].name' }
            : { id: 'clusterName', label: 'Cluster name', type: 'text', auto: domAuto('-cl01'), help: 'Name of the first cluster.', api: 'computeSpec.clusterSpecs[].name' },
          ...(CL ? [{ id: 'datacenter', label: 'Datacenter name', type: 'text', maxLen: 80, help: 'vCenter datacenter for the cluster. Only needed when the domain vCenter has more than one datacenter.', api: 'computeSpec.clusterSpecs[].datacenterName' }] : []),
          { id: 'imageId', label: 'Cluster image ID', type: 'text', help: 'ID of the vSphere Lifecycle Manager cluster image (SDDC Manager &gt; Lifecycle Management &gt; Image Management, or <code>GET /v1/personalities</code>). Required for vCenter 9.0 and later.', api: 'computeSpec.clusterSpecs[].clusterImageId', lookup: imageLookup },
          { id: 'evc', label: 'EVC mode', type: 'select', def: '', options: [{ v: '', l: 'Disabled' }].concat(['INTEL_SKYLAKE', 'INTEL_CASCADELAKE', 'INTEL_ICELAKE', 'INTEL_SAPPHIRERAPIDS', 'AMD_ZEN', 'AMD_ZEN2', 'AMD_ZEN3', 'AMD_ZEN4'].map(v => ({ v, l: v }))), help: 'Enhanced vMotion Compatibility baseline.', api: 'computeSpec.clusterSpecs[].advancedOptions.evcMode' },
          ...(CL ? [
            { id: 'remoteDsName', label: 'Remote vSAN datastore name', type: 'text', rerender: true, show: compute, ph: 'sfo-w01-cl01-ds-vsan01', help: 'Workbook "vSAN Datastore Name" of the vSAN storage cluster to mount. Used for the UUID lookup; not part of the JSON.' },
            { id: 'remoteDsUuid', label: 'Remote vSAN datastore UUID', type: 'text', show: compute, help: 'UUID of the vSAN datastore to mount (vSAN container ID). Leave empty to keep a placeholder.', api: 'computeSpec.clusterSpecs[].datastoreSpec.vsanRemoteDatastoreClusterSpec.vsanRemoteDatastoreSpec[].datastoreUuid', lookup: datastoreLookup },
          ] : []),
          { id: 'datastoreName', label: 'Datastore name', type: 'text', maxLen: 80, req: true, show: s => !compute(s), auto: (s, g) => g('clusterName') ? g('clusterName') + '-ds-' + (isVsan(s) ? 'vsan01' : s.storage === 'nfs' ? 'nfs01' : 'vmfs01') : '', help: 'Datastore name (required for Day-N operations).', api: 'computeSpec.clusterSpecs[].datastoreSpec.vsanDatastoreSpec.datastoreName' },
          { id: 'ftt', label: 'Failures to tolerate', type: 'select', options: C.ftt.concat([{ v: '3', l: '3 failures (RAID-1 mirroring)', d: 'Tolerates three host failures. Requires at least 7 hosts.' }]), def: '1', show: s => s.storage === 'vsan-osa', help: 'vSAN OSA failures to tolerate.', api: 'computeSpec.clusterSpecs[].datastoreSpec.vsanDatastoreSpec.failuresToTolerate' },
          { id: 'dedup', label: 'Deduplication and compression', type: 'checkbox', show: isVsan, help: 'vSAN ESA: global deduplication plus compression of the datastore (on top of the compression of the ESA storage policy). vSAN OSA: deduplication and compression on all-flash disk groups (not for hybrid). Workbook "vSAN: Deduplication and Compression".', api: 'computeSpec.clusterSpecs[].datastoreSpec.vsanDatastoreSpec.dedupAndCompressionEnabled' },
          { id: 'esaAutoClaim', label: 'Allow auto claim of HCL incompatible disks', type: 'checkbox', show: isEsa, help: 'Lets vSAN ESA claim non-certified disks (labs only).', api: 'computeSpec.clusterSpecs[].datastoreSpec.vsanDatastoreSpec.esaConfig.skipHclAutoDiskClaim' },
          { id: 'dit', label: 'vSAN data-in-transit encryption', type: 'checkbox', show: vsanNet, rerender: true, help: 'Encrypt vSAN traffic between hosts (workbook "Remote Data-in-Transit encryption" for a vSAN compute cluster).', api: 'computeSpec.clusterSpecs[].datastoreSpec.vsanDatastoreSpec.encryptionConfig.dataInTransitConfig.enable' },
          { id: 'rekey', label: 'Rekey interval', type: 'select', options: C.rekey, def: '1440', show: s => vsanNet(s) && s.dit, rerender: true, help: 'Key rotation interval.' },
          { id: 'rekeyCustom', label: 'Custom rekey interval (minutes)', type: 'text', fmt: 'int', req: true, show: s => vsanNet(s) && s.dit && s.rekey === 'custom', help: '30 - 10080 minutes.', check: v => (Number(v) >= 30 && Number(v) <= 10080) || 'Between 30 and 10080 minutes' },
          { id: 'nfsServer', label: 'NFS server', type: 'text', fmt: 'ipOrFqdn', req: true, show: s => s.storage === 'nfs', ph: '10.13.15.4', help: 'NFS v3 server.', api: 'computeSpec.clusterSpecs[].datastoreSpec.nfsDatastoreSpecs[].nasVolume.serverName[]' },
          { id: 'nfsPath', label: 'NFS share path', type: 'text', req: true, show: s => s.storage === 'nfs', ph: '/sfo-w01-cl01-ds-nfs01-share', help: 'Exported path.', check: v => v.startsWith('/') || 'Path must start with /', api: 'computeSpec.clusterSpecs[].datastoreSpec.nfsDatastoreSpecs[].nasVolume.path' },
        ],
      },
      {
        id: 'vds', title: 'Distributed switches', num: true, show: full,
        intro: 'Host management (vmk0) stays on the existing ESX management VLAN; the port group is created on switch 1.' + (CL ? ' The VM management port group for NSX Edges is created manually after deployment (workbook "Network Traffic: VM Management").' : ''),
        fields: [
          { id: 'vdsProfile', label: 'Switch profile', type: 'select', options: C.vdsProfile, def: 'default', rerender: true, help: 'Pre-configured switch layouts.' },
          { id: 'vdsCount', label: 'Number of switches', type: 'select', show: custom, def: '1', rerender: true, options: [{ v: '1', l: '1' }, { v: '2', l: '2' }, { v: '3', l: '3' }], help: 'Switches in the custom layout.' },
          ...TRAFFIC.map(t => ({ id: 'vdsFor_' + t.k, label: t.label + ' on switch', type: 'select', def: '1', show: s => custom(s) && t.show(s) && Number(s.vdsCount) > 1, options: [{ v: '1', l: 'Switch 1' }, { v: '2', l: 'Switch 2' }, { v: '3', l: 'Switch 3' }], help: 'Switch carrying ' + t.label + '.' })),
          { id: 'vdsFor_nsx', label: 'NSX on switch', type: 'select', def: '1', show: s => custom(s) && Number(s.vdsCount) > 1, options: [{ v: '1', l: 'Switch 1' }, { v: '2', l: 'Switch 2' }, { v: '3', l: 'Switch 3' }], help: 'Switch prepared for NSX.' },
          { type: 'note', kind: 'info', text: s => layoutText(s) },
          ...vds,
          { id: 'pgAdvanced', label: 'Customize port group load balancing and uplinks', type: 'checkbox', def: false, rerender: true, help: 'When off, port groups use "Route based on physical NIC load" with all uplinks active (workbook default).' },
          ...TRAFFIC.map(t => ({ id: 'pg_' + t.k, label: t.label + ' port group', type: 'text', show: s => full(s) && t.show(s), maxLen: 80, auto: (s, g) => { const v = g('vds' + vdsOf(s, t.k) + 'Name'); return v ? v + '-pg-' + t.pg : ''; }, help: 'Distributed port group for ' + t.label + ' traffic.', api: API + '.portGroupSpecs[].name' })),
          ...trafficFields(),
        ],
      },
      CL ? {
        id: 'nsx', title: 'NSX', num: true,
        intro: 'The cluster joins the NSX instance of the workload domain. Names must match that NSX instance.',
        fields: [vpcType, vpcConn, nsxMode, overlayTz, vlanTzOn, vlanTz],
      } : {
        id: 'nsx', title: 'NSX Manager', num: true,
        intro: 'To share an existing NSX instance with another workload domain, enter that NSX instance VIP and node FQDNs.',
        fields: [
          { id: 'nsxInstance', label: 'NSX Manager instance', type: 'select', def: 'new', rerender: true, options: [
            { v: 'new', l: 'Create new NSX Manager instance', d: 'Recommended if the domain does not need workload mobility with an existing domain.' },
            { v: 'join', l: 'Join existing NSX Manager instance', d: 'Share the NSX instance of another workload domain. Enter that instance\'s VIP, appliance FQDNs and passwords below.' },
          ], help: 'Workbook "NSX Manager Instance Options".' },
          { id: 'nsxModel', label: 'Deployment size', type: 'select', def: 'ha', rerender: true, options: [
            { v: 'ha', l: 'NSX Management Cluster (3 nodes)', d: 'Three NSX Manager appliances. Recommended for production.' },
            { v: 'single', l: 'Single NSX Manager appliance', d: 'One appliance only. Labs / PoC.' },
          ], help: 'Number of NSX Manager appliances.' },
          { id: 'nsxSize', label: 'Appliance size', type: 'select', def: 'medium', options: [{ v: 'small', l: 'Small', d: 'Lab only.' }].concat(C.nsxSize), help: 'NSX Manager form factor.', api: 'nsxTSpec.formFactor' },
          fqdnField('nsxVip', 'Cluster (VIP) FQDN', 'sfo-w01-nsx01.sfo.rainpole.io', 'FQDN of the NSX Manager cluster VIP.', 'nsxTSpec.vipFqdn'),
          { id: 'nsxVipIp', label: 'Cluster (VIP) IP address', type: 'text', fmt: 'ipv4', help: 'Optional (deprecated in the API). Workbook value; must match DNS.', api: 'nsxTSpec.vip' },
          fqdnField('nsxA', 'Appliance 1 FQDN', 'sfo-w01-nsx01a.sfo.rainpole.io', 'NSX Manager node A.', 'nsxTSpec.nsxManagerSpecs[].networkDetailsSpec.dnsName'),
          fqdnField('nsxB', 'Appliance 2 FQDN', 'sfo-w01-nsx01b.sfo.rainpole.io', 'NSX Manager node B.', 'nsxTSpec.nsxManagerSpecs[].networkDetailsSpec.dnsName', { show: nsxHA }),
          fqdnField('nsxC', 'Appliance 3 FQDN', 'sfo-w01-nsx01c.sfo.rainpole.io', 'NSX Manager node C.', 'nsxTSpec.nsxManagerSpecs[].networkDetailsSpec.dnsName', { show: nsxHA }),
          { id: 'nsxAIp', label: 'Appliance 1 IP address', type: 'text', fmt: 'ipv4', help: 'Optional (deprecated in the API). Workbook value; must match DNS.', api: 'nsxTSpec.nsxManagerSpecs[].networkDetailsSpec.ipAddress' },
          { id: 'nsxBIp', label: 'Appliance 2 IP address', type: 'text', fmt: 'ipv4', show: nsxHA, help: 'Optional (deprecated in the API).', api: 'nsxTSpec.nsxManagerSpecs[].networkDetailsSpec.ipAddress' },
          { id: 'nsxCIp', label: 'Appliance 3 IP address', type: 'text', fmt: 'ipv4', show: nsxHA, help: 'Optional (deprecated in the API).', api: 'nsxTSpec.nsxManagerSpecs[].networkDetailsSpec.ipAddress' },
          pwField('nsxAdminPw', 'Admin password', C.pw.nsx, 'NSX admin password.', 'nsxTSpec.nsxManagerAdminPassword'),
          pwField('nsxRootPw', 'Root password', C.pw.nsx, 'NSX root password.', 'nsxTSpec.nsxManagerRootPassword'),
          pwField('nsxAuditPw', 'Audit password', C.pw.nsx, 'NSX audit password.', 'nsxTSpec.nsxManagerAuditPassword'),
          nsxMode, overlayTz, vlanTzOn, vlanTz, vpcType, vpcConn,
        ],
      },
      {
        id: 'tep', title: 'Host overlay (TEP)', num: true, show: s => full(s) && fullStack(s),
        intro: s => l3(s) ? '<b>Rack 1.</b> TEP IP assignment and NSX teaming apply to all racks.' : '',
        fields: [
          t1[0],
          { id: 'tepMode', label: 'TEP IP assignment', type: 'select', options: C.tepMode, def: 'pool', rerender: true, help: 'How host TEPs get IPs.' },
          ...t1.slice(1),
          { id: 'nsxTeam', label: 'NSX teaming policy', type: 'select', options: C.nsxTeaming, def: 'LOADBALANCE_SRCID', help: 'Teaming in the uplink profile. A LAG always uses failover order.', api: NSXP + '.uplinkProfiles[].teamings[].policy' },
          { id: 'nsxU1', label: 'Active uplink uplink-1', type: 'select', options: STATE.slice(0, 2), def: 'Active', help: 'Workbook "Active Uplink uplink-1". Standby is used with failover order.', api: NSXP + '.uplinkProfiles[].teamings[].activeUplinks' },
          { id: 'nsxU2', label: 'Active uplink uplink-2', type: 'select', options: STATE.slice(0, 2), def: 'Active', help: 'Workbook "Active Uplink uplink-2".', api: NSXP + '.uplinkProfiles[].teamings[].standByUplinks' },
        ],
      },
      ...Array.from({ length: MAX_RACKS - 1 }, (_, i) => rackSection(i + 2)),
      CL ? null : {
        id: 'dtgw', title: 'Distributed connectivity', num: true, show: distributed,
        intro: 'Distributed transit gateway and Virtual Network Appliances (VNA).',
        fields: [
          { id: 'dtgwVlan', label: 'DTGW VLAN ID', type: 'text', fmt: 'vlan', req: true, ph: '1398', help: 'VLAN for the distributed transit gateway.', api: 'nsxTSpec.vpcSpec.dtgwSpec.vlan' },
          { id: 'dtgwGw', label: 'Gateway CIDR', type: 'text', fmt: 'gwcidr', req: true, ph: '10.13.98.1/24', help: 'Gateway on the DTGW VLAN with prefix.', api: 'nsxTSpec.vpcSpec.dtgwSpec.gatewayCidr' },
          { id: 'dtgwExt', label: 'External IP block CIDR', type: 'text', fmt: 'netcidr', req: true, ph: '10.13.97.0/24', help: 'External IP block for VPCs.', api: 'nsxTSpec.vpcSpec.dtgwSpec.externalIpBlockCidr' },
          { id: 'dtgwPriv', label: 'Private TGW IP block CIDR', type: 'text', fmt: 'netcidr', def: '172.31.0.0/16', help: 'Private transit gateway block.', api: 'nsxTSpec.vpcSpec.dtgwSpec.privateTgwIpBlockCidr' },
          fqdnField('vnaA', 'VNA 1 FQDN', 'sfo-w01-vna01.sfo.rainpole.io', 'First Virtual Network Appliance.', 'nsxTSpec.vnaSpec.vnaNodesSpec[]'),
          fqdnField('vnaB', 'VNA 2 FQDN', 'sfo-w01-vna02.sfo.rainpole.io', 'Second Virtual Network Appliance.', 'nsxTSpec.vnaSpec.vnaNodesSpec[]'),
          { id: 'vnaUseMgmt', label: 'Use ESX management VMkernel settings for VNA management', type: 'checkbox', def: false, rerender: true, help: 'VNAs use the same subnet as host vmk0. Otherwise give the VLAN and gateway of the VNA management network.' },
          { id: 'vnaVlan', label: 'VNA management VLAN', type: 'text', fmt: 'vlan', req: true, show: s => !s.vnaUseMgmt, ph: '1310', help: 'VLAN of the VNA management port group.', api: 'nsxTSpec.vnaSpec.vnaManagementVlanId' },
          { id: 'vnaGw', label: 'VNA management gateway CIDR', type: 'text', fmt: 'gwcidr', req: true, show: s => !s.vnaUseMgmt, ph: '10.13.10.1/24', help: 'Gateway with prefix of the VNA management network.', api: 'nsxTSpec.vnaSpec.vnaManagementGatewayCidr' },
        ],
      },
      {
        id: 'sup', title: 'vSphere Supervisor', num: true, show: s => full(s) && sup(s),
        intro: 'Single-zone vSphere Supervisor with NSX VPC networking.',
        fields: [
          { id: 'supName', label: 'Supervisor name', type: 'text', auto: CL ? clAuto('-sn01') : domAuto('-sn01'), help: 'Name of the Supervisor.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.supervisorName' },
          { id: 'zoneName', label: 'vSphere zone name', type: 'text', req: true, auto: CL ? clAuto('-zn01') : domAuto('-zn01'), help: 'vSphere zone created for the cluster.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.zoneName' },
          { id: 'svcCidr', label: 'Service CIDR', type: 'text', fmt: 'netcidr', req: true, def: '172.29.0.0/16', help: 'Kubernetes service CIDR.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.serviceCidr' },
          { id: 'cpStart', label: 'Control plane IP range start', type: 'text', fmt: 'ipv4', req: true, ph: '10.13.10.201', help: 'First control plane VM IP (5 addresses recommended).', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.managementNetwork.controlPlaneIpRange.startIpAddress' },
          { id: 'cpEnd', label: 'Control plane IP range end', type: 'text', fmt: 'ipv4', req: true, ph: '10.13.10.205', help: 'Last control plane VM IP.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.managementNetwork.controlPlaneIpRange.endIpAddress' },
          { id: 'supUseMgmt', label: 'Use ESX management VMkernel settings', type: 'checkbox', def: false, rerender: true, help: 'Put the control plane on the host management network instead of a separate VLAN.' },
          { id: 'supVlan', label: 'Management VLAN', type: 'text', fmt: 'vlan', req: true, show: s => !s.supUseMgmt, ph: '1310', help: 'VLAN of the Supervisor management network.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.managementNetwork.details.vlanId' },
          { id: 'supGw', label: 'Management gateway CIDR', type: 'text', fmt: 'gwcidr', req: true, show: s => !s.supUseMgmt, ph: '10.13.10.1/24', help: 'Gateway with prefix of the Supervisor management network.', api: ['computeSpec.clusterSpecs[].supervisorActivationSpec.managementNetwork.details.gateway', 'computeSpec.clusterSpecs[].supervisorActivationSpec.managementNetwork.details.netMask'] },
          { id: 'supDns', label: 'Workload DNS servers', type: 'text', req: true, fmt: 'ipv4', list: true, ph: '10.11.10.4,10.11.10.5', auto: () => [C.from('mgmt', 'dns1'), C.from('mgmt', 'dns2')].filter(Boolean).join(','), help: 'Comma separated DNS servers. Empty: the DNS servers from the Management Domain tab.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.vpcNetwork.dnsServers' },
          { id: 'supNtp', label: 'Workload NTP servers', type: 'text', req: true, fmt: 'ipOrFqdn', list: true, ph: 'ntp0.sfo.rainpole.io,ntp1.sfo.rainpole.io', auto: () => [C.from('mgmt', 'ntp1'), C.from('mgmt', 'ntp2')].filter(Boolean).join(','), help: 'Comma separated NTP servers. Empty: the NTP servers from the Management Domain tab.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.vpcNetwork.ntpServers' },
          { id: 'supPrivCidr', label: 'Private (transit gateway) CIDR', type: 'text', fmt: 'netcidr', def: '172.30.0.0/16', show: distributed, help: 'Private CIDR for VPCs when using distributed connectivity.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.vpcNetwork.privateCidr' },
          { id: 'nsxProject', label: 'NSX project path', type: 'text', help: 'Optional. Only when using an existing NSX instance.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.vpcNetwork.nsxProject' },
          { id: 'vpcProfile', label: 'VPC connectivity profile', type: 'text', help: 'Optional. Only when using an existing NSX instance.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.vpcNetwork.nsxVpcConnectivityProfile' },
        ],
      },
    ].filter(Boolean);
    let num = 0;
    for (const sec of sections) if (sec.num) sec.title = (++num) + '. ' + sec.title;

    const form = CL ? {
      id: 'cluster',
      tab: 'Deploy Cluster',
      title: 'SDDC Manager - Add a Cluster to a Workload Domain',
      intro: 'Generates three files for a new cluster in an existing workload domain: <b>1)</b> the network pool, <b>2)</b> host commissioning, <b>3)</b> the cluster spec. The domain ID, host IDs, network pool ID and cluster image ID come from SDDC Manager: use the <b>Get from VCF</b> panels, or replace the placeholders in the JSON.',
      schema: { api: 'sddc-manager-api', root: 'ClusterCreationSpec' },
      sections,
    } : {
      id: 'wld',
      tab: 'Workload Domain',
      title: 'SDDC Manager - VI Workload Domain',
      intro: 'Generates three files for a new VI workload domain in SDDC Manager: <b>1)</b> the network pool, <b>2)</b> host commissioning, <b>3)</b> the domain spec. Host IDs, the network pool ID and the cluster image ID only exist after steps 1 and 2: use the <b>Get from VCF</b> panels, or replace the placeholders in the JSON.',
      schema: { api: 'sddc-manager-api', root: 'DomainCreationSpec' },
      sections,
    };

    // ---------- rules ----------
    form.rules = function (s, g) {
      const out = [];
      if (!CL && s.nsxInstance === 'join') out.push({ level: 'info', field: 'nsxInstance', msg: 'Joining an existing NSX instance: the NSX values must be those of the existing instance' });
      // same VLAN or subnet as the management domain (Management Domain tab)
      const mn = mgmtNets();
      const own = [];
      for (const r of racksOf(s)) {
        const x = rp(r);
        if (createPool(s, r)) {
          for (const [k, label, , on] of POOLNETS) if (on(s)) own.push([x + k, label + (l3(s) ? ' (rack ' + r + ')' : ''), s[x + k + 'Mode'] !== 'dhcp']);
        }
        if (full(s) && fullStack(s)) own.push([x + 'tep', 'Host overlay' + (l3(s) ? ' (rack ' + r + ')' : ''), s.tepMode === 'pool' && !s[x + 'tepReuse']]);
      }
      if (!CL && distributed(s)) own.push(['dtgw', 'DTGW', true]);
      for (const [k, label, hasGw] of own) {
        const v = String(g(k + 'Vlan') || '').trim();
        const m = v && v !== '0' && mn.find(n => n.vlan === v);
        if (m) out.push({ level: 'warn', field: k + 'Vlan', msg: label + ' VLAN ' + v + ' is the management domain ' + m.label + ' VLAN (Management Domain tab); use a VLAN of its own for the workload domain' });
        const c = hasGw && N.isCidr(s[k + 'Gw']) ? s[k + 'Gw'] : null;
        const o = c && mn.find(n => n.cidr && N.cidrsOverlap(c, n.cidr.cidr));
        if (o) out.push({ level: 'warn', field: k + 'Gw', msg: label + ' subnet overlaps the management domain ' + o.label + ' subnet ' + o.cidr.network + '/' + o.cidr.prefix + ' (Management Domain tab); use a subnet of its own for the workload domain' });
      }
      if (!full(s)) return out;
      const racks = racksOf(s);
      const multi = racks.length > 1;
      const inRack = r => multi ? ' (rack ' + r + ')' : '';
      const rackHosts = r => (s[rp(r) + 'hosts'] || []).filter(h => (h.fqdn || '').trim());
      const n = racks.reduce((a, r) => a + rackHosts(r).length, 0);
      if (s.storage === 'vsan-osa' && s.ftt === '3' && n < 7) out.push({ level: 'error', field: 'hosts', msg: 'vSAN OSA with FTT=3 needs at least 7 hosts' });
      if (s.secondary === 'client' && s.storage !== 'vsan-max') out.push({ level: 'error', field: 'secondary', msg: 'vSAN storage client network requires vSAN Storage Cluster as principal storage' });
      if (s.secondary === 'nfs' && s.storage === 'nfs') out.push({ level: 'error', field: 'secondary', msg: 'Secondary NFS network is not available when NFS is the principal storage' });
      if (fullStack(s)) {
        if (s.nsxTeam === 'FAILOVER_ORDER' && s.nsxU1 === 'Active' && s.nsxU2 === 'Active') out.push({ level: 'warn', field: 'nsxU2', msg: 'NSX failover order with two active uplinks; set one to Standby' });
        if (s.nsxU1 !== 'Active' && s.nsxU2 !== 'Active') out.push({ level: 'error', field: 'nsxU1', msg: 'NSX teaming needs at least one active uplink' });
      }
      if (s.pgAdvanced) {
        for (const t of TRAFFIC) {
          if (!t.show(s)) continue;
          if (s['u1_' + t.k] !== 'Active' && s['u2_' + t.k] !== 'Active') out.push({ level: 'error', field: 'u1_' + t.k, msg: t.label + ' port group needs at least one Active uplink' });
          if (s['team_' + t.k] === 'failover_explicit' && s['u1_' + t.k] === 'Active' && s['u2_' + t.k] === 'Active') out.push({ level: 'warn', field: 'u2_' + t.k, msg: t.label + ': explicit failover with two active uplinks; set one to Standby' });
        }
      }
      if (isVsan(s) && n < 3) out.push({ level: 'error', field: 'hosts', msg: 'vSAN needs at least 3 hosts' });
      if (s.storage === 'vsan-osa' && s.ftt === '2' && n < 5) out.push({ level: 'error', field: 'hosts', msg: 'vSAN OSA with FTT=2 needs at least 5 hosts' });
      const seen = {};
      let missingIds = 0;
      for (const r of racks) {
        (s[rp(r) + 'hosts'] || []).forEach((h, i) => {
          const k = (h.fqdn || '').trim().toLowerCase();
          if (k && seen[k]) out.push({ level: 'error', field: rp(r) + 'hosts.' + i + '.fqdn', msg: 'Duplicate host ' + k });
          if (k) seen[k] = 1;
          if (k && !(h.id || '').trim()) missingIds++;
        });
        const x = rp(r);
        if (!commission(s)) continue;
        if (!(s[x + 'poolId'] || '').trim() && s[x + 'poolMode'] === 'reuse') out.push({ level: 'info', field: x + 'poolId', msg: 'Re-using a network pool' + inRack(r) + ': enter the existing pool ID or replace the placeholder in the commissioning JSON' });
        else if (!(s[x + 'poolId'] || '').trim()) out.push({ level: 'info', field: x + 'poolId', msg: 'Network pool ID' + inRack(r) + ' is empty; the commissioning JSON contains a placeholder (the UI variant uses the pool name instead)' });
      }
      if (missingIds) out.push({ level: 'warn', field: 'hosts', msg: missingIds + ' host(s) have no SDDC Manager host ID; the ' + (CL ? 'cluster' : 'domain') + ' JSON contains placeholders until you commission the hosts and paste the IDs' });
      if (!(s.imageId || '').trim()) out.push({ level: 'warn', field: 'imageId', msg: 'Cluster image ID is empty; it is required for vCenter 9.0 and later' });
      if (CL && !(s.domainId || '').trim()) out.push({ level: 'warn', field: 'domainId', msg: 'Workload domain ID is empty; the cluster JSON contains a placeholder' });
      if (CL && compute(s) && !(s.remoteDsUuid || '').trim()) out.push({ level: 'warn', field: 'remoteDsUuid', msg: 'Remote vSAN datastore UUID is empty; the cluster JSON contains a placeholder' });
      if (multi && isVsan(s)) out.push({ level: 'info', field: 'clusterType', msg: 'Configure one vSAN fault domain per rack in vCenter after deployment (workbook "vSAN Fault Domain"); it is not part of the JSON' });

      const nsxIdx = vdsOf(s, 'nsx');
      const tepPerHost = s['vds' + nsxIdx + 'Type'] === 'lag' ? 1 : (C.list(s['vds' + nsxIdx + 'Nics']).length || 2);
      const nets = [];
      for (const r of racks) {
        const x = rp(r);
        const rn = rackHosts(r).length;
        if (createPool(s, r)) {
          for (const [k, label, , on] of POOLNETS) {
            if (!on(s) || s[x + k + 'Mode'] === 'dhcp') continue;
            C.rangeRules(out, { label: label + inRack(r), gw: s[x + k + 'Gw'], start: s[x + k + 'Start'], end: s[x + k + 'End'], fieldStart: x + k + 'Start', fieldEnd: x + k + 'End', need: rn, needMsg: 'needs one per host (' + rn + ')' });
            nets.push([x + k + 'Gw', label + inRack(r)]);
          }
        }
        if (fullStack(s) && s.tepMode === 'pool' && !s[x + 'tepReuse']) {
          const need = rn * tepPerHost;
          C.rangeRules(out, { label: 'TEP pool' + inRack(r), gw: s[x + 'tepGw'], start: s[x + 'tepStart'], end: s[x + 'tepEnd'], fieldStart: x + 'tepStart', fieldEnd: x + 'tepEnd', need, needMsg: 'needs ' + need + ' (one per host uplink)' });
          nets.push([x + 'tepGw', 'TEP' + inRack(r)]);
        }
      }
      if (!CL && distributed(s)) nets.push(['dtgwGw', 'DTGW']);
      if (sup(s)) {
        const cnt = C.rangeRules(out, { label: 'Supervisor control plane', gw: s.supUseMgmt ? null : s.supGw, start: s.cpStart, end: s.cpEnd, fieldStart: 'cpStart', fieldEnd: 'cpEnd', need: 3, needMsg: 'needs at least 3 (5 recommended)' });
        if (cnt && cnt < 5) out.push({ level: 'info', field: 'cpEnd', msg: 'Supervisor control plane range has ' + cnt + ' addresses; 5 are recommended for upgrades' });
        if (!fullStack(s)) out.push({ level: 'warn', field: 'vpcType', msg: 'vSphere Supervisor with NSX VPC networking requires Full Stack VPC' });
      }
      for (let i = 0; i < nets.length; i++) {
        for (let j = i + 1; j < nets.length; j++) {
          if (N.cidrsOverlap(s[nets[i][0]], s[nets[j][0]])) out.push({ level: 'error', field: nets[j][0], msg: nets[j][1] + ' subnet overlaps ' + nets[i][1] });
        }
      }
      const nicsUsed = {};
      for (let i = 1; i <= vdsCount(s); i++) {
        const nics = C.list(s['vds' + i + 'Nics']);
        if (nics.length < 2) out.push({ level: 'warn', field: 'vds' + i + 'Nics', msg: 'Switch ' + i + ' has fewer than 2 NICs' });
        for (const x of nics) {
          if (nicsUsed[x]) out.push({ level: 'error', field: 'vds' + i + 'Nics', msg: x + ' is used on switch ' + nicsUsed[x] + ' and switch ' + i });
          nicsUsed[x] = i;
        }
        const mtu = Number(s['vds' + i + 'Mtu']);
        for (const r of racks) {
          for (const t of TRAFFIC) {
            if (!t.show(s) || vdsOf(s, t.k) !== i || t.k === 'mgmt') continue;
            const m = Number(s[rp(r) + t.k + 'Mtu']);
            if (m && mtu && m > mtu) out.push({ level: 'error', field: rp(r) + t.k + 'Mtu', msg: t.label + inRack(r) + ' MTU ' + m + ' exceeds switch ' + i + ' MTU ' + mtu });
          }
        }
        if (fullStack(s) && nsxIdx === i && mtu && mtu < 1600) out.push({ level: 'error', field: 'vds' + i + 'Mtu', msg: 'Switch ' + i + ' carries NSX overlay and needs MTU 1600 or higher' });
      }
      if (!CL && s.autoPw) out.push({ level: 'info', msg: 'vCenter / NSX passwords are omitted and will be generated by SDDC Manager' });
      return out;
    };

    // ---------- builders ----------
    form.build = function (s, g) {
      const files = [];
      const withPw = !CL && !s.autoPw;
      if (!full(s)) return [domainFile(s, g, null, withPw)];
      const racks = racksOf(s);
      const multi = racks.length > 1;
      const rackRows = r => (s[rp(r) + 'hosts'] || []).filter(h => (h.fqdn || '').trim());
      const storageType = s.storage === 'vsan-max' ? 'VSAN_MAX' : compute(s) ? 'VSAN_REMOTE' : C.storageTypeCommission[s.storage];

      // 1. network pool(s)
      for (const r of racks) {
        if (!createPool(s, r)) continue;
        const x = rp(r);
        const networks = POOLNETS.filter(p => p[3](s)).map(p => poolNetwork(s, p[2], x + p[0]));
        files.push({
          name: pre(g) + '-1-network-pool' + rackSfx(r) + '.json', title: 'Network pool' + (multi ? ' (rack ' + r + ')' : ''), json: { name: g(x + 'poolName'), networks },
          method: 'POST', endpoint: '/v1/network-pools', note: 'Or SDDC Manager UI: Network Settings &gt; Network Pool.',
          schema: { api: 'sddc-manager-api', type: 'NetworkPool' },
        });
      }

      // 2. host commissioning
      const commissionSpec = racks.map(r => rackRows(r).map(h => {
        const o = { fqdn: h.fqdn.trim(), username: 'root', password: s.esxPw, storageType, networkPoolId: (s[rp(r) + 'poolId'] || '').trim() || (r > 1 ? '<--ENTER-NETWORK-POOL-ID-RACK-' + r + '-->' : POOL_ID_PH), networkPoolName: g(rp(r) + 'poolName') };
        if (isEsa(s) && s.skipHcl) o.skipHclCompatibilityPrecheck = true;
        return o;
      })).flat();
      if (commission(s)) files.push({
        name: pre(g) + '-2-commission-hosts-api.json', title: 'Commission hosts (API)', json: commissionSpec,
        method: 'POST', endpoint: '/v1/hosts  (validate first: POST /v1/hosts/validations)',
        schema: { api: 'sddc-manager-api', type: 'HostCommissionSpec' },
      });
      if (commission(s)) files.push({
        name: pre(g) + '-2-commission-hosts-ui.json', title: 'Commission hosts (UI import)',
        json: { hosts: commissionSpec.map(h => ({ fqdn: h.fqdn, username: h.username, storageType: h.storageType, password: h.password, networkPoolName: h.networkPoolName })) },
        note: 'SDDC Manager UI: Hosts &gt; Commission Hosts &gt; Import (JSON).',
      });

      // 3. cluster
      const nsxIdx = vdsOf(s, 'nsx');
      const vmNics = [];
      for (let i = 1; i <= vdsCount(s); i++) {
        const lag = lagOf(s, g, i);
        C.list(s['vds' + i + 'Nics']).forEach((id, n) => vmNics.push({ id, vdsName: g('vds' + i + 'Name'), uplink: lag ? lag + '-' + n : 'uplink' + (n + 1) }));
      }
      const profiled = multi && fullStack(s);
      const hostSpecs = racks.map(r => rackRows(r).map(h => {
        const hns = { vmNics };
        if (profiled) hns.networkProfileName = g(rp(r) + 'netProfile');
        return { id: (h.id || '').trim() || HOST_ID_PH, hostName: h.fqdn.trim(), hostNetworkSpec: hns };
      })).flat();

      const pgs = TRAFFIC.filter(t => t.show(s)).map(t => {
        const i = vdsOf(s, t.k);
        return { i, spec: Object.assign({ name: g('pg_' + t.k), transportType: t.type }, pgUplinks(s, g, t.k, i)) };
      });

      const mode = s.nsxMode === 'default' ? 'ENS_INTERRUPT' : s.nsxMode;
      const vdsSpecs = [];
      for (let i = 1; i <= vdsCount(s); i++) {
        const v = { name: g('vds' + i + 'Name'), mtu: C.int(s['vds' + i + 'Mtu']) };
        const mine = pgs.filter(p => p.i === i).map(p => p.spec);
        if (mine.length) v.portGroupSpecs = mine;
        if (i === nsxIdx) {
          const tz = s.vlanTzOn ? [{ name: g('vlanTz'), transportType: 'VLAN' }] : [];
          if (fullStack(s)) tz.push({ name: g('overlayTz'), transportType: 'OVERLAY' });
          v.nsxtSwitchConfig = { transportZones: tz, hostSwitchOperationalMode: mode };
        }
        const lag = lagOf(s, g, i);
        if (lag) v.lagSpecs = [{ name: lag, uplinksCount: C.list(s['vds' + i + 'Nics']).length, lacpMode: s['vds' + i + 'LacpMode'], loadBalancingMode: s['vds' + i + 'LagLb'], lacpTimeoutMode: s['vds' + i + 'LacpTimeout'] }];
        vdsSpecs.push(v);
      }

      const networkSpec = { vdsSpecs };
      if (fullStack(s)) {
        const lag = lagOf(s, g, nsxIdx);
        const up = uplinks(s, nsxIdx);
        const st = n => (n === 0 ? s.nsxU1 : n === 1 ? s.nsxU2 : 'Active');
        const teaming = lag
          ? { policy: 'FAILOVER_ORDER', activeUplinks: [lag], standByUplinks: [] }
          : { policy: s.nsxTeam, activeUplinks: up.filter((_, n) => st(n) === 'Active'), standByUplinks: up.filter((_, n) => st(n) === 'Standby') };
        const tcs = { uplinkProfiles: racks.map(r => ({ name: g(rp(r) + 'uplinkProfile'), transportVlan: C.int(g(rp(r) + 'tepVlan')), teamings: [teaming] })) };
        if (s.tepMode === 'pool') {
          tcs.ipAddressPoolsSpec = racks.map(r => {
            const x = rp(r);
            const ip = { name: g(x + 'tepPoolName') };
            if (!s[x + 'tepReuse']) {
              const c = N.parseCidr(s[x + 'tepGw']);
              ip.subnets = [{ cidr: c ? c.cidr : '', gateway: c ? c.ip : '', ipAddressPoolRanges: [{ start: s[x + 'tepStart'], end: s[x + 'tepEnd'] }] }];
            }
            return ip;
          });
        }
        networkSpec.nsxClusterSpec = { nsxTClusterSpec: tcs };
        const map = lag ? [{ vdsUplinkName: lag, nsxUplinkName: lag }] : up.map(u => ({ vdsUplinkName: u, nsxUplinkName: u }));
        networkSpec.networkProfiles = racks.map(r => {
          const hsc = { vdsName: g('vds' + nsxIdx + 'Name'), uplinkProfileName: g(rp(r) + 'uplinkProfile'), vdsUplinkToNsxUplink: map };
          if (s.tepMode === 'pool') hsc.ipAddressPoolName = g(rp(r) + 'tepPoolName');
          return { name: g(rp(r) + 'netProfile'), isDefault: r === 1, nsxtHostSwitchConfigs: [hsc] };
        });
      } else {
        networkSpec.nsxClusterSpec = { nsxTClusterSpec: { overlayVtepSpec: { vtepType: 'NO_IP' } } };
      }

      const datastoreSpec = {};
      const encryption = () => {
        const e = { dataInTransitConfig: { enable: !!s.dit } };
        if (s.dit) e.dataInTransitConfig.rekeyInterval = Number(s.rekey === 'custom' ? s.rekeyCustom : s.rekey);
        return e;
      };
      if (isVsan(s)) {
        const v = { datastoreName: g('datastoreName') };
        if (isEsa(s)) {
          v.esaConfig = { enabled: true };
          if (s.storage === 'vsan-max') v.esaConfig.vsanMaxConfig = { enableVsanMax: true, enableVsanExternalNetwork: clientNet(s) };
          if (s.esaAutoClaim) v.esaConfig.skipHclAutoDiskClaim = true;
          if (s.dedup) v.dedupAndCompressionEnabled = true;
        } else {
          v.esaConfig = { enabled: false };
          v.failuresToTolerate = Number(s.ftt);
          v.dedupAndCompressionEnabled = !!s.dedup;
        }
        v.encryptionConfig = encryption();
        datastoreSpec.vsanDatastoreSpec = v;
      } else if (compute(s)) {
        datastoreSpec.vsanRemoteDatastoreClusterSpec = { vsanRemoteDatastoreSpec: [{ datastoreUuid: (s.remoteDsUuid || '').trim() || DS_PH, encryptionConfig: encryption() }] };
      } else if (s.storage === 'nfs') {
        datastoreSpec.nfsDatastoreSpecs = [{ datastoreName: g('datastoreName'), nasVolume: { serverName: [g('nfsServer')], path: g('nfsPath'), readOnly: false } }];
      } else {
        datastoreSpec.vmfsDatastoreSpec = { fcSpec: [{ datastoreName: g('datastoreName') }] };
      }

      const cluster = { name: g('clusterName'), clusterImageId: (s.imageId || '').trim() || IMAGE_PH };
      if (CL && g('datacenter')) cluster.datacenterName = g('datacenter');
      Object.assign(cluster, { hostSpecs, datastoreSpec, networkSpec });
      if (s.evc) cluster.advancedOptions = { evcMode: s.evc };

      if (sup(s)) {
        const cidr = N.parseCidr(g('svcCidr'));
        const sa = {
          supervisorName: g('supName'),
          zoneName: g('zoneName'),
          serviceCidr: cidr ? { address: cidr.network, prefix: cidr.prefix } : null,
          managementNetwork: { controlPlaneIpRange: { startIpAddress: s.cpStart, endIpAddress: s.cpEnd } },
          vpcNetwork: { dnsServers: C.list(g('supDns')), ntpServers: C.list(g('supNtp')) },
        };
        if (!s.supUseMgmt) {
          const c = N.parseCidr(s.supGw);
          sa.managementNetwork.details = { vlanId: C.int(s.supVlan), gateway: c ? c.ip : '', netMask: c ? c.mask : '', vdsName: g('vds1Name') };
        }
        if (distributed(s) && g('supPrivCidr')) {
          const p = N.parseCidr(g('supPrivCidr'));
          if (p) sa.vpcNetwork.privateCidr = { address: p.network, prefix: p.prefix };
        }
        if (g('nsxProject')) sa.vpcNetwork.nsxProject = g('nsxProject');
        if (g('vpcProfile')) sa.vpcNetwork.nsxVpcConnectivityProfile = g('vpcProfile');
        cluster.supervisorActivationSpec = sa;
      }

      files.push(CL ? clusterFile(s, g, cluster) : domainFile(s, g, cluster, withPw));
      return files;
    };

    // ---------- import ----------
    form.detect = CL
      ? j => j && !Array.isArray(j) && !!j.domainId && !!j.computeSpec && !j.vcenterSpec
      : j => j && !Array.isArray(j) && !!j.vcenterSpec && (!!j.computeSpec || (j.domainName !== undefined && !!j.nsxTSpec));
    form.rawSchema = () => ({ api: 'sddc-manager-api', type: CL ? 'ClusterCreationSpec' : 'DomainCreationSpec' });
    const KNOWN = CL ? ['domainId', 'computeSpec', 'deployWithoutLicenseKeys'] : ['domainName', 'vcenterSpec', 'computeSpec', 'nsxTSpec', 'ssoDomainSpec', 'deployWithoutLicenseKeys'];

    form.fromJson = function (j) {
      const s = {};
      const notes = [];
      s.noLicense = j.deployWithoutLicenseKeys !== false && j.deployWithoutLicenseKeys !== 'false';
      if (CL) s.domainId = str(j.domainId).indexOf('<--') === 0 ? '' : str(j.domainId);
      else {
        s.domainName = str(j.domainName);
        s.deployType = j.computeSpec ? 'full' : 'infra';
        const vc = j.vcenterSpec || {};
        s.vcFqdn = str((vc.networkDetailsSpec || {}).dnsName);
        s.vcIp = str((vc.networkDetailsSpec || {}).ipAddress);
        s.vcName = str(vc.name);
        s.datacenter = str(vc.datacenterName);
        if (vc.vmSize) s.vcSize = String(vc.vmSize).toLowerCase();
        s.vcStorage = str(vc.storageSize).toLowerCase();
        s.vcRootPw = str(vc.rootPassword);
        const sso = j.ssoDomainSpec || {};
        s.ssoDomain = str(sso.ssoDomainName); s.ssoPw = str(sso.ssoDomainPassword);
      }

      const clusters = (j.computeSpec || {}).clusterSpecs || [];
      if (clusters.length > 1) notes.push('Only the first cluster was imported.');
      clusterFromJson(clusters[0] || {}, s, notes);

      if (!CL) {
        const nsx = j.nsxTSpec || {};
        const mgrs = nsx.nsxManagerSpecs || [];
        s.nsxModel = mgrs.length >= 3 ? 'ha' : 'single';
        s.nsxVip = str(nsx.vipFqdn);
        const dn = m => str(((m || {}).networkDetailsSpec || {}).dnsName);
        s.nsxA = dn(mgrs[0]); s.nsxB = dn(mgrs[1]); s.nsxC = dn(mgrs[2]);
        const ip = m => str(((m || {}).networkDetailsSpec || {}).ipAddress);
        s.nsxAIp = ip(mgrs[0]); s.nsxBIp = ip(mgrs[1]); s.nsxCIp = ip(mgrs[2]);
        s.nsxVipIp = str(nsx.vip);
        if (nsx.formFactor) s.nsxSize = String(nsx.formFactor).toLowerCase();
        s.nsxAdminPw = str(nsx.nsxManagerAdminPassword); s.nsxRootPw = str(nsx.nsxManagerRootPassword); s.nsxAuditPw = str(nsx.nsxManagerAuditPassword);
        s.autoPw = !(s.vcRootPw || s.nsxAdminPw || s.ssoPw);
        const vpc = nsx.vpcSpec || {};
        if (vpc.vpcNetworkConfigurationType === 'VLAN_BACKED_VPC') s.vpcType = 'vlan';
        if (vpc.vpcNetworkConfigurationType === 'FULL_STACK_VPC') s.vpcType = 'full';
        if (vpc.dtgwSpec) {
          s.vpcConn = 'distributed';
          s.dtgwVlan = str(vpc.dtgwSpec.vlan); s.dtgwGw = str(vpc.dtgwSpec.gatewayCidr);
          s.dtgwExt = str(vpc.dtgwSpec.externalIpBlockCidr); s.dtgwPriv = str(vpc.dtgwSpec.privateTgwIpBlockCidr);
        } else s.vpcConn = 'centralized';
        const vna = nsx.vnaSpec;
        if (vna) {
          s.vnaA = str((vna.vnaNodesSpec || [])[0]); s.vnaB = str((vna.vnaNodesSpec || [])[1]);
          s.vnaUseMgmt = vna.vnaManagementVlanId === undefined;
          s.vnaVlan = str(vna.vnaManagementVlanId); s.vnaGw = str(vna.vnaManagementGatewayCidr);
        }
      } else {
        const sa = (clusters[0] || {}).supervisorActivationSpec;
        s.vpcConn = sa && sa.vpcNetwork && sa.vpcNetwork.privateCidr ? 'distributed' : 'centralized';
        notes.push('The workload domain name is not part of the cluster spec; enter it for the lookups and generated names.');
      }
      const allHosts = racksOf(s).map(r => s[rp(r) + 'hosts'] || []).flat();
      s.commissioned = allHosts.length > 0 && allHosts.every(h => h.id);
      notes.push(s.commissioned
        ? 'All hosts have SDDC Manager host IDs, so they are treated as already commissioned: only the ' + (CL ? 'cluster' : 'domain') + ' spec is generated (untick "Hosts are already commissioned" to get the network pool and commissioning files).'
        : 'Network pool and host commissioning values are not part of the ' + (CL ? 'cluster' : 'domain') + ' spec; fill in the network pool and hosts sections if you need those files.');
      const extra = {};
      for (const k of Object.keys(j)) if (!KNOWN.includes(k)) extra[k] = j[k];
      if (Object.keys(extra).length) notes.push('Fields kept unchanged in the output: ' + Object.keys(extra).join(', '));
      return { state: s, extra, notes };
    };

    function clusterFromJson(cl, s, notes) {
      s.clusterName = str(cl.name);
      if (CL) s.datacenter = str(cl.datacenterName);
      s.imageId = cl.clusterImageId && cl.clusterImageId.indexOf('<--') !== 0 ? cl.clusterImageId : '';
      s.evc = str((cl.advancedOptions || {}).evcMode);
      const hs = cl.hostSpecs || [];
      const hostRow = h => ({ fqdn: str(h.hostName || h.hostname), id: str(h.id).indexOf('<--') === 0 ? '' : str(h.id) });

      const ds = cl.datastoreSpec || {};
      const ditFrom = enc => {
        const dit = enc && enc.dataInTransitConfig;
        s.dit = !!(dit && dit.enable);
        if (dit && dit.rekeyInterval) {
          const r = String(dit.rekeyInterval);
          if (C.rekey.some(o => o.v === r)) s.rekey = r; else { s.rekey = 'custom'; s.rekeyCustom = r; }
        }
      };
      if (ds.vsanDatastoreSpec) {
        const v = ds.vsanDatastoreSpec;
        const esa = v.esaConfig && (v.esaConfig.enabled === true || v.esaConfig.enabled === 'true');
        const max = esa && v.esaConfig.vsanMaxConfig && v.esaConfig.vsanMaxConfig.enableVsanMax;
        s.storage = max ? 'vsan-max' : esa ? 'vsan-esa' : 'vsan-osa';
        if (max && v.esaConfig.vsanMaxConfig.enableVsanExternalNetwork) s.secondary = 'client';
        s.datastoreName = str(v.datastoreName);
        s.esaAutoClaim = !!(v.esaConfig && v.esaConfig.skipHclAutoDiskClaim);
        s.dedup = !!v.dedupAndCompressionEnabled;
        if (v.failuresToTolerate) s.ftt = ['1', '2', '3'].includes(String(v.failuresToTolerate)) ? String(v.failuresToTolerate) : '1';
        ditFrom(v.encryptionConfig);
      } else if (ds.vsanRemoteDatastoreClusterSpec && CL) {
        const rd = (ds.vsanRemoteDatastoreClusterSpec.vsanRemoteDatastoreSpec || [])[0] || {};
        s.storage = 'vsan-compute';
        s.remoteDsUuid = str(rd.datastoreUuid).indexOf('<--') === 0 ? '' : str(rd.datastoreUuid);
        ditFrom(rd.encryptionConfig);
      } else if (ds.nfsDatastoreSpecs) {
        s.storage = 'nfs';
        const n = ds.nfsDatastoreSpecs[0] || {};
        s.datastoreName = str(n.datastoreName);
        s.nfsServer = str(((n.nasVolume || {}).serverName || [])[0]);
        s.nfsPath = str((n.nasVolume || {}).path);
      } else if (ds.vmfsDatastoreSpec) {
        s.storage = 'fc';
        s.datastoreName = str(((ds.vmfsDatastoreSpec.fcSpec || [])[0] || {}).datastoreName);
      }

      const ns = cl.networkSpec || {};
      const vdsList = ns.vdsSpecs || [];
      const firstNics = ((hs[0] || {}).hostNetworkSpec || {}).vmNics || [];
      const find = t => vdsList.findIndex(v => (v.portGroupSpecs || []).some(p => p.transportType === t)) + 1;
      const nsxIdx = vdsList.findIndex(v => v.nsxtSwitchConfig) + 1 || 1;
      const stIdx = find('VSAN') || find('NFS') || 1;
      const count = vdsList.length || 1;
      let profile = 'custom';
      if ((find('MANAGEMENT') || 1) === 1 && (find('VMOTION') || 1) === 1 && (find('VSAN_EXTERNAL') || 1) === 1) {
        if (count === 1) profile = 'default';
        else if (count === 2 && stIdx === 2 && nsxIdx === 1) profile = 'storage';
        else if (count === 2 && stIdx === 1 && nsxIdx === 2) profile = 'nsx';
        else if (count === 3 && stIdx === 2 && nsxIdx === 3) profile = 'storage-nsx';
      }
      s.vdsProfile = profile;
      s.vdsCount = String(Math.min(count, 3));
      if (profile === 'custom') {
        for (const t of TRAFFIC) s['vdsFor_' + t.k] = String(find(t.type) || 1);
        s.vdsFor_nsx = String(nsxIdx);
      }
      vdsList.slice(0, 3).forEach((v, n) => {
        const i = n + 1;
        s['vds' + i + 'Name'] = str(v.name);
        s['vds' + i + 'Mtu'] = str(v.mtu || 9000);
        s['vds' + i + 'Nics'] = firstNics.filter(x => x.vdsName === v.name).map(x => x.id).join(',');
        const lag = (v.lagSpecs || [])[0];
        s['vds' + i + 'Type'] = lag ? 'lag' : 'uplinks';
        if (lag) {
          s['vds' + i + 'LagName'] = str(lag.name);
          s['vds' + i + 'LacpMode'] = str(lag.lacpMode).toUpperCase() || 'ACTIVE';
          s['vds' + i + 'LagLb'] = str(lag.loadBalancingMode);
          s['vds' + i + 'LacpTimeout'] = str(lag.lacpTimeoutMode).toUpperCase() || 'SLOW';
        }
        for (const p of v.portGroupSpecs || []) {
          const t = TRAFFIC.find(x => x.type === p.transportType);
          if (!t) continue;
          s['pg_' + t.k] = str(p.name);
          if (t.k === 'nfs' && s.storage !== 'nfs') s.secondary = 'nfs';
          if (lag) continue;
          const act = p.activeUplinks || [], stby = p.standByUplinks || [];
          const stOf = u => act.includes(u) ? 'Active' : stby.includes(u) ? 'Standby' : 'Unused';
          s['team_' + t.k] = p.teamingPolicy || 'loadbalance_loadbased';
          s['u1_' + t.k] = stOf('uplink1');
          s['u2_' + t.k] = stOf('uplink2');
          if (s['team_' + t.k] !== 'loadbalance_loadbased' || s['u1_' + t.k] !== 'Active' || s['u2_' + t.k] !== 'Active') s.pgAdvanced = true;
        }
        if (v.nsxtSwitchConfig) {
          const m = v.nsxtSwitchConfig.hostSwitchOperationalMode;
          s.nsxMode = !m || m === 'ENS_INTERRUPT' ? 'default' : m;
          s.vlanTzOn = (v.nsxtSwitchConfig.transportZones || []).some(z => z.transportType === 'VLAN');
          for (const z of v.nsxtSwitchConfig.transportZones || []) {
            if (z.transportType === 'OVERLAY') s.overlayTz = str(z.name);
            if (z.transportType === 'VLAN') s.vlanTz = str(z.name);
          }
        }
      });

      const tcs = ((ns.nsxClusterSpec || {}).nsxTClusterSpec) || {};
      s.vpcType = tcs.overlayVtepSpec && tcs.overlayVtepSpec.vtepType === 'NO_IP' ? 'vlan' : 'full';
      const ups = tcs.uplinkProfiles || [];
      const pools = tcs.ipAddressPoolsSpec || [];
      const t = ((ups[0] || {}).teamings || [])[0];
      if (t && t.policy) {
        s.nsxTeam = t.policy;
        const a = t.activeUplinks || [], b = t.standByUplinks || [];
        s.nsxU1 = b.includes('uplink1') && !a.includes('uplink1') ? 'Standby' : 'Active';
        s.nsxU2 = b.includes('uplink2') && !a.includes('uplink2') ? 'Standby' : 'Active';
      }
      if (!ups.length && tcs.geneveVlanId !== undefined) s.tepVlan = str(tcs.geneveVlanId);
      s.tepMode = pools.length ? 'pool' : 'dhcp';

      const profiles = (ns.networkProfiles || []).slice().sort((a, b) => (b.isDefault === true) - (a.isDefault === true));
      const profileOf = h => ((h.hostNetworkSpec || {}).networkProfileName) || '';
      const multi = profiles.length > 1 && hs.some(profileOf);
      const rackProfiles = multi ? profiles.slice(0, MAX_RACKS) : [profiles[0] || {}];
      if (multi) {
        s.clusterType = 'l3';
        s.rackCount = String(rackProfiles.length);
        if (profiles.length > MAX_RACKS) notes.push('Only the first ' + MAX_RACKS + ' racks (network profiles) were imported.');
      }
      rackProfiles.forEach((p, n) => {
        const r = n + 1, x = rp(r);
        const hsc = (p.nsxtHostSwitchConfigs || [])[0] || {};
        if (p.name) s[x + 'netProfile'] = str(p.name);
        const up = ups.find(u => u.name === hsc.uplinkProfileName) || ups[n];
        if (up) { s[x + 'uplinkProfile'] = str(up.name); s[x + 'tepVlan'] = str(up.transportVlan); }
        const pool = pools.find(q => q.name === hsc.ipAddressPoolName) || pools[n];
        if (pool) {
          s[x + 'tepPoolName'] = str(pool.name);
          const sub = (pool.subnets || [])[0];
          if (sub) {
            const pfx = sub.cidr && sub.cidr.indexOf('/') > 0 ? sub.cidr.split('/')[1] : '24';
            s[x + 'tepGw'] = sub.gateway ? sub.gateway + '/' + pfx : '';
            const rg = (sub.ipAddressPoolRanges || [])[0] || {};
            s[x + 'tepStart'] = str(rg.start); s[x + 'tepEnd'] = str(rg.end);
          } else s[x + 'tepReuse'] = true;
        }
        s[x + 'hosts'] = multi ? hs.filter(h => profileOf(h) === p.name || (r === 1 && !rackProfiles.some(q => q.name === profileOf(h)))).map(hostRow) : hs.map(hostRow);
      });

      const sa = cl.supervisorActivationSpec;
      s.supervisor = !!sa;
      if (sa) {
        s.supName = str(sa.supervisorName); s.zoneName = str(sa.zoneName);
        if (sa.serviceCidr) s.svcCidr = sa.serviceCidr.address + '/' + sa.serviceCidr.prefix;
        const mn = sa.managementNetwork || {};
        s.cpStart = str((mn.controlPlaneIpRange || {}).startIpAddress); s.cpEnd = str((mn.controlPlaneIpRange || {}).endIpAddress);
        if (mn.details) {
          s.supUseMgmt = false;
          s.supVlan = str(mn.details.vlanId);
          const p = Net.maskToPrefix(mn.details.netMask);
          s.supGw = mn.details.gateway ? mn.details.gateway + '/' + (p === null ? 24 : p) : '';
        } else s.supUseMgmt = true;
        const vn = sa.vpcNetwork || {};
        s.supDns = (vn.dnsServers || []).join(','); s.supNtp = (vn.ntpServers || []).join(',');
        if (vn.privateCidr) s.supPrivCidr = vn.privateCidr.address + '/' + vn.privateCidr.prefix;
        s.nsxProject = str(vn.nsxProject); s.vpcProfile = str(vn.nsxVpcConnectivityProfile);
      }
    }

    form.sample = CL ? function () {
      const hosts = [];
      for (let i = 1; i <= 4; i++) hosts.push({ fqdn: 'sfo01-w01-r01-esx0' + i + '.sfo.rainpole.io', id: '' });
      return {
        domainName: 'sfo-w01', clusterName: 'sfo-w01-cl02', storage: 'vsan-esa',
        poolName: 'sfo01-w01-r01-network-pool-01',
        vmotionVlan: '1312', vmotionMtu: '9000', vmotionGw: '10.13.12.1/24', vmotionStart: '10.13.12.101', vmotionEnd: '10.13.12.116',
        vsanVlan: '1313', vsanMtu: '9000', vsanGw: '10.13.13.1/24', vsanStart: '10.13.13.101', vsanEnd: '10.13.13.116',
        esxPw: 'VMw@re1!', hosts, datastoreName: 'sfo-w01-cl02-ds-vsan01',
        vdsProfile: 'default', vds1Name: 'sfo-w01-cl02-vds01', vds1Nics: 'vmnic0,vmnic1',
        vpcType: 'full', overlayTz: 'overlay-tz-sfo-w01-nsx01', vlanTzOn: false,
        tepVlan: '1314', tepMode: 'pool', tepPoolName: 'sfo01-w01-r01-ip-pool01-host', tepReuse: true,
        uplinkProfile: 'sfo01-w01-r01-uplink-profile01', netProfile: 'sfo01-sfo-w01-cl02-r01-network-profile',
      };
    } : function () {
      const pwd = 'VMw@re1!VMw@re1!';
      const hosts = [];
      for (let i = 1; i <= 4; i++) hosts.push({ fqdn: 'sfo01-w01-r01-esx0' + i + '.sfo.rainpole.io', id: '' });
      return {
        domainName: 'sfo-w01', storage: 'vsan-esa', supervisor: true,
        poolName: 'sfo01-w01-r01-network-pool-01',
        vmotionVlan: '1312', vmotionMtu: '9000', vmotionGw: '10.13.12.1/24', vmotionStart: '10.13.12.101', vmotionEnd: '10.13.12.116',
        vsanVlan: '1313', vsanMtu: '9000', vsanGw: '10.13.13.1/24', vsanStart: '10.13.13.101', vsanEnd: '10.13.13.116',
        esxPw: 'VMw@re1!', hosts,
        vcFqdn: 'sfo-w01-vc01.sfo.rainpole.io', vcSize: 'medium', vcRootPw: pwd, ssoDomain: 'sfo-w01.local', ssoPw: pwd,
        clusterName: 'sfo-w01-cl01', datastoreName: 'sfo-w01-cl01-ds-vsan01',
        vdsProfile: 'default', vds1Name: 'sfo-w01-cl01-vds01', vds1Nics: 'vmnic0,vmnic1',
        nsxModel: 'ha', nsxSize: 'medium', nsxVip: 'sfo-w01-nsx01.sfo.rainpole.io', nsxA: 'sfo-w01-nsx01a.sfo.rainpole.io', nsxB: 'sfo-w01-nsx01b.sfo.rainpole.io', nsxC: 'sfo-w01-nsx01c.sfo.rainpole.io',
        nsxAdminPw: pwd, nsxRootPw: pwd, nsxAuditPw: pwd, overlayTz: 'overlay-tz-sfo-w01-nsx01', vpcType: 'full', vpcConn: 'centralized',
        tepVlan: '1314', tepMode: 'pool', tepPoolName: 'sfo01-w01-r01-ip-pool01-host', tepGw: '10.13.14.1/24', tepStart: '10.13.14.101', tepEnd: '10.13.14.132',
        uplinkProfile: 'sfo01-w01-r01-uplink-profile01', netProfile: 'sfo01-sfo-w01-cl01-r01-network-profile',
        supName: 'sfo-w01-sn01', zoneName: 'sfo-w01-zn01', svcCidr: '172.29.0.0/16', cpStart: '10.13.10.201', cpEnd: '10.13.10.205',
        supVlan: '1310', supGw: '10.13.10.1/24', supDns: '10.11.10.4,10.11.10.5', supNtp: 'ntp0.sfo.rainpole.io,ntp1.sfo.rainpole.io',
      };
    };

    return form;
  }

  const str = v => (v === undefined || v === null ? '' : String(v));

  function poolNetwork(s, type, p) {
    if (s[p + 'Mode'] === 'dhcp') return { type, vlanId: C.int(s[p + 'Vlan']), mtu: C.int(s[p + 'Mtu']), ipAddressVersion: 'IPv4', ipAddressAssignmentMode: 'DHCP' };
    const c = N.parseCidr(s[p + 'Gw']);
    return {
      type,
      vlanId: C.int(s[p + 'Vlan']),
      mtu: C.int(s[p + 'Mtu']),
      subnet: c ? c.network : '',
      mask: c ? c.mask : '',
      gateway: c ? c.ip : '',
      ipPools: [{ start: s[p + 'Start'], end: s[p + 'End'] }],
    };
  }

  function pgUplinks(s, g, k, i) {
    const lag = lagOf(s, g, i);
    if (lag) return { teamingPolicy: 'failover_explicit', activeUplinks: [lag], standByUplinks: [] };
    const ups = uplinks(s, i);
    if (!s.pgAdvanced) return { teamingPolicy: 'loadbalance_loadbased', activeUplinks: ups, standByUplinks: [] };
    const st = n => (n === 0 ? s['u1_' + k] : n === 1 ? s['u2_' + k] : 'Active');
    return { teamingPolicy: s['team_' + k], activeUplinks: ups.filter((_, n) => st(n) === 'Active'), standByUplinks: ups.filter((_, n) => st(n) === 'Standby') };
  }

  function lagOf(s, g, i) {
    return s['vds' + i + 'Type'] === 'lag' ? g('vds' + i + 'LagName') : null;
  }

  function domainFile(s, g, cluster, withPw) {
    const nsxNode = id => {
      const d = { dnsName: g(id) };
      if (g(id + 'Ip')) d.ipAddress = g(id + 'Ip');
      return { name: N.shortName(g(id)), networkDetailsSpec: d };
    };
    const nsx = {
      nsxManagerSpecs: [nsxNode('nsxA')].concat(nsxHA(s) ? [nsxNode('nsxB'), nsxNode('nsxC')] : []),
      vipFqdn: g('nsxVip'),
      formFactor: s.nsxSize,
    };
    if (g('nsxVipIp')) nsx.vip = g('nsxVipIp');
    if (withPw) Object.assign(nsx, { nsxManagerAdminPassword: s.nsxAdminPw, nsxManagerRootPassword: s.nsxRootPw, nsxManagerAuditPassword: s.nsxAuditPw });
    // vpcNetworkConfigurationType only applies to shell (infrastructure only) domains
    if (!full(s)) nsx.vpcSpec = { vpcNetworkConfigurationType: fullStack(s) ? 'FULL_STACK_VPC' : 'VLAN_BACKED_VPC' };
    if (distributed(s)) {
      const dt = { vlan: C.int(s.dtgwVlan), gatewayCidr: g('dtgwGw'), externalIpBlockCidr: g('dtgwExt') };
      if (g('dtgwPriv')) dt.privateTgwIpBlockCidr = g('dtgwPriv');
      nsx.vpcSpec = Object.assign(nsx.vpcSpec || {}, { dtgwSpec: dt });
      nsx.vnaSpec = { vnaNodesSpec: [g('vnaA'), g('vnaB')] };
      if (!s.vnaUseMgmt) Object.assign(nsx.vnaSpec, { vnaManagementVlanId: C.int(s.vnaVlan), vnaManagementGatewayCidr: g('vnaGw') });
    }

    const vc = {
      name: g('vcName'),
      networkDetailsSpec: Object.assign({ dnsName: g('vcFqdn') }, g('vcIp') ? { ipAddress: g('vcIp') } : {}),
      datacenterName: g('datacenter'),
      vmSize: s.vcSize,
    };
    if (s.vcStorage) vc.storageSize = s.vcStorage;
    if (withPw) vc.rootPassword = s.vcRootPw;

    const dom = {
      domainName: g('domainName'),
      vcenterSpec: vc,
      nsxTSpec: nsx,
      ssoDomainSpec: { ssoDomainName: g('ssoDomain') },
      deployWithoutLicenseKeys: !!s.noLicense,
    };
    if (cluster) dom.computeSpec = { clusterSpecs: [cluster] };
    if (withPw) dom.ssoDomainSpec.ssoDomainPassword = s.ssoPw;
    return {
      name: (g('domainName') || 'wld') + '-3-domain.json', title: 'Workload domain spec', main: true, json: dom,
      method: 'POST', endpoint: '/v1/domains  (validate first: POST /v1/domains/validations)',
      note: 'Replace placeholders (<code>&lt;--ENTER-...--&gt;</code>) with real IDs before submitting.',
      schema: { api: 'sddc-manager-api', type: 'DomainCreationSpec' },
    };
  }

  function clusterFile(s, g, cluster) {
    return {
      name: (g('clusterName') || 'cluster') + '-3-cluster.json', title: 'Cluster spec', main: true,
      json: { domainId: (s.domainId || '').trim() || DOMAIN_PH, computeSpec: { clusterSpecs: [cluster] }, deployWithoutLicenseKeys: !!s.noLicense },
      method: 'POST', endpoint: '/v1/clusters  (validate first: POST /v1/clusters/validations)',
      note: 'Replace placeholders (<code>&lt;--ENTER-...--&gt;</code>) with real IDs before submitting.',
      schema: { api: 'sddc-manager-api', type: 'ClusterCreationSpec' },
    };
  }

  App.register(makeForm('wld'));
  App.register(makeForm('cluster'));
})();
