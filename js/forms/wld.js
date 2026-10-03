// SDDC Manager: VI workload domain (network pool, host commissioning, DomainCreationSpec).
(function () {
  const C = Common;
  const N = Net;
  const HOST_ID_PH = '<--ENTER-SDDC-HOST-ID-->';
  const POOL_ID_PH = '<--ENTER-NETWORK-POOL-ID-->';
  const IMAGE_PH = '<--ENTER-CLUSTER-IMAGE-ID-->';
  const API = 'computeSpec.clusterSpecs[].networkSpec.vdsSpecs[]';

  const full = s => s.deployType !== 'infra';
  const isVsan = s => ['vsan-esa', 'vsan-osa', 'vsan-max'].includes(s.storage);
  const isEsa = s => s.storage === 'vsan-esa' || s.storage === 'vsan-max';
  const nfsNet = s => s.storage === 'nfs' || (s.secondary === 'nfs' && s.storage !== 'nfs');
  const clientNet = s => s.storage === 'vsan-max' && s.secondary === 'client';
  const createPool = s => full(s) && s.poolMode !== 'reuse';
  const STATE = [{ v: 'Active', l: 'Active' }, { v: 'Standby', l: 'Standby' }, { v: 'Unused', l: 'Unused' }];
  const fullStack = s => s.vpcType === 'full';
  const distributed = s => fullStack(s) && s.vpcConn === 'distributed';
  const nsxHA = s => s.nsxModel === 'ha';
  const custom = s => s.vdsProfile === 'custom';
  const sup = s => !!s.supervisor;

  const TRAFFIC = [
    { k: 'mgmt', type: 'MANAGEMENT', label: 'ESX management', pg: 'esx-mgmt', show: () => true },
    { k: 'vmotion', type: 'VMOTION', label: 'vMotion', pg: 'vmotion', show: () => true },
    { k: 'vsan', type: 'VSAN', label: 'vSAN', pg: 'vsan', show: isVsan },
    { k: 'nfs', type: 'NFS', label: 'NFS', pg: 'nfs', show: nfsNet },
    { k: 'vsanext', type: 'VSAN_EXTERNAL', label: 'vSAN storage client', pg: 'vsan-client', show: clientNet },
  ];
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
  const vdsNameAuto = i => (s, g) => g('clusterName') ? g('clusterName') + '-vds0' + i : '';
  const uplinks = (s, i) => C.list(s['vds' + i + 'Nics']).map((_, n) => 'uplink' + (n + 1));
  const pw = s => !s.autoPw;

  function fqdnField(id, label, ph, help, api, extra) {
    return Object.assign({ id, label, type: 'text', fmt: 'fqdn', req: true, ph, help, api }, extra || {});
  }
  function pwField(id, label, rule, help, api, extra) {
    return Object.assign({ id, label, type: 'password', req: pw, show: pw, pw: rule, help, api }, extra || {});
  }
  function poolNet(p, title, o) {
    const show = st => createPool(st) && (!o.show || o.show(st));
    const stat = st => show(st) && st[p + 'Mode'] !== 'dhcp';
    return [
      { type: 'note', text: '<b>' + title + '</b>', show },
      { id: p + 'Mode', label: 'IP assignment', type: 'select', def: 'static', rerender: true, show, options: [
        { v: 'static', l: 'Static', d: 'SDDC Manager assigns VMkernel IPs from the range below.' },
        { v: 'dhcp', l: 'DHCP', d: 'VMkernel adapters get IPs from a DHCP server on this VLAN. No range needed.' },
      ], help: 'Workbook "IP Assignment" of the network pool network.', api: 'networks[].ipAddressAssignmentMode' },
      { id: p + 'Vlan', label: 'VLAN ID', type: 'text', fmt: 'vlan', req: true, ph: o.vlan, show, help: 'VLAN of this network.', api: 'networks[].vlanId' },
      { id: p + 'Mtu', label: 'MTU', type: 'text', fmt: 'mtu', req: true, def: '9000', show, help: 'MTU of the VMkernel network. 9000 recommended.', api: 'networks[].mtu' },
      { id: p + 'Gw', label: 'Gateway (CIDR notation)', type: 'text', fmt: 'gwcidr', req: true, ph: o.gw, show: stat, help: 'Gateway with prefix length. Subnet and mask are derived.', api: ['networks[].gateway', 'networks[].subnet', 'networks[].mask'] },
      { id: p + 'Start', label: 'IP range start', type: 'text', fmt: 'ipv4', req: true, ph: o.start, show: stat, help: 'First address of the network pool range (one per host).', api: 'networks[].ipPools[].start' },
      { id: p + 'End', label: 'IP range end', type: 'text', fmt: 'ipv4', req: true, ph: o.end, show: stat, help: 'Last address of the network pool range.', api: 'networks[].ipPools[].end' },
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

  const form = {
    id: 'wld',
    tab: 'Workload Domain',
    title: 'SDDC Manager - VI Workload Domain',
    intro: 'Generates three files for a new VI workload domain in SDDC Manager: <b>1)</b> the network pool, <b>2)</b> host commissioning, <b>3)</b> the domain spec. Host IDs and the network pool ID only exist after steps 1 and 2; paste them here afterwards (from <code>GET /v1/network-pools</code> and <code>GET /v1/hosts?status=UNASSIGNED_USEABLE</code>) or replace the placeholders in the JSON.',
    schema: { api: 'sddc-manager-api', root: 'DomainCreationSpec' },
    sections: [
      {
        id: 'general', title: 'General',
        fields: [
          { id: 'domainName', label: 'Workload domain name', type: 'text', req: true, ph: 'sfo-w01', pattern: '^[a-zA-Z0-9-]{3,20}$', patternMsg: '3-20 characters: letters, digits and hyphens', help: 'Name of the workload domain in SDDC Manager.', api: 'domainName' },
          { id: 'deployType', label: 'Deployment type', type: 'select', def: 'full', rerender: true, options: [
            { v: 'full', l: 'Full deployment with cluster', d: 'vCenter, NSX and the first vSphere cluster with hosts, storage and networking.' },
            { v: 'infra', l: 'Deploy infrastructure only', d: 'Shell domain: vCenter and NSX only, no cluster. Add clusters later. Only the domain spec is generated.' },
          ], help: 'Workbook "Deployment Type".', api: 'computeSpec' },
          { id: 'storage', label: 'Principal storage', type: 'select', show: full, options: C.storage.slice(0, 2).concat([{ v: 'vsan-max', l: 'vSAN Storage Cluster (vSAN Max)', d: 'Disaggregated vSAN ESA storage cluster that provides storage to other (client) clusters. ESA-certified hosts required.' }], C.storage.slice(2)), def: 'vsan-esa', rerender: true, help: 'Workbook "Principal Storage Model" of the first cluster.', api: 'computeSpec.clusterSpecs[].datastoreSpec' },
          { id: 'secondary', label: 'Secondary storage network', type: 'select', show: full, def: 'none', rerender: true, options: [
            { v: 'none', l: 'None' },
            { v: 'nfs', l: 'Secondary NFS storage network', d: 'Adds an NFS VMkernel network (network pool + port group) for mounting additional NFS datastores later. Not available when NFS is the principal storage.' },
            { v: 'client', l: 'vSAN storage client network', d: 'Separate network for vSAN Max client traffic (VSAN_EXTERNAL). Only with vSAN Storage Cluster.' },
          ], help: 'Workbook "Secondary Storage".' },
          { id: 'supervisor', label: 'Enable vSphere Supervisor', type: 'checkbox', def: false, rerender: true, show: full, help: 'Activate a single-zone vSphere Supervisor with NSX VPC networking during domain creation.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec' },
          { id: 'autoPw', label: 'Auto-generate passwords', type: 'checkbox', def: false, rerender: true, help: 'Leave vCenter / NSX passwords out so SDDC Manager generates them. ESX root password is still needed for commissioning.' },
          { id: 'noLicense', label: 'Deploy without license keys', type: 'checkbox', def: true, help: 'VCF 9 licenses through VCF Operations; keep enabled unless you use legacy keys.', api: 'deployWithoutLicenseKeys' },
        ],
      },
      {
        id: 'pool', title: '1. Network pool', show: full,
        intro: 'vMotion and storage IP pools for the hosts. Created in SDDC Manager before commissioning the hosts.',
        fields: [
          { id: 'poolMode', label: 'VCF network pool', type: 'select', def: 'create', rerender: true, options: [
            { v: 'create', l: 'Create a new VCF network pool', d: 'Generates the network pool JSON (file 1).' },
            { v: 'reuse', l: 'Re-use an existing VCF network pool', d: 'Hosts are commissioned into an existing pool; no network pool file is generated.' },
          ], help: 'Workbook "VCF Network Pool Type".' },
          { id: 'poolName', label: 'Network pool name', type: 'text', auto: (s, g) => g('domainName') ? g('domainName') + '-np01' : '', help: 'Name of the SDDC Manager network pool (new or existing).', api: 'name' },
          ...poolNet('vmotion', 'vMotion', { vlan: '1312', gw: '10.13.12.1/24', start: '10.13.12.101', end: '10.13.12.116' }),
          ...poolNet('vsan', 'vSAN', { vlan: '1313', gw: '10.13.13.1/24', start: '10.13.13.101', end: '10.13.13.116', show: isVsan }),
          ...poolNet('nfs', 'NFS', { vlan: '1315', gw: '10.13.15.1/24', start: '10.13.15.101', end: '10.13.15.116', show: nfsNet }),
          ...poolNet('vsanext', 'vSAN storage client', { vlan: '1316', gw: '10.13.16.1/24', start: '10.13.16.101', end: '10.13.16.116', show: clientNet }),
        ],
      },
      {
        id: 'hosts', title: '2. Hosts', show: full,
        intro: 'Hosts to commission and add to the first cluster. After commissioning, copy each host ID from SDDC Manager into the table.',
        fields: [
          { id: 'esxPw', label: 'ESX root password', type: 'password', req: true, pw: C.pw.esx, help: 'Root password of the hosts, used for commissioning.', api: 'password' },
          { id: 'poolId', label: 'Network pool ID', type: 'text', help: 'ID of the network pool from <code>GET /v1/network-pools</code>. Leave empty to keep a placeholder in the commissioning JSON.', api: 'networkPoolId' },
          { id: 'skipHcl', label: 'Skip vSAN ESA HCL compatibility pre-check', type: 'checkbox', show: isEsa, help: 'Bypass vSAN ESA HCL validation during commissioning (hosts without certified disks or when SDDC Manager cannot verify disks).', api: 'skipHclCompatibilityPrecheck' },
          {
            id: 'hosts', label: 'Hosts', type: 'rows', min: 2, max: 64, initial: 3, addLabel: 'Add host',
            help: 'Hosts for the first cluster of the domain.',
            columns: [
              { id: 'fqdn', label: 'Host FQDN', type: 'text', fmt: 'fqdn', req: true, ph: (s, g, i) => 'sfo01-w01-r01-esx0' + ((i || 0) + 1) + '.sfo.rainpole.io', help: 'FQDN of the ESX host.', api: 'computeSpec.clusterSpecs[].hostSpecs[].hostName' },
              { id: 'id', label: 'SDDC Manager host ID', type: 'text', help: 'UUID of the commissioned host (GET /v1/hosts?status=UNASSIGNED_USEABLE). Leave empty until the host is commissioned.', api: 'computeSpec.clusterSpecs[].hostSpecs[].id', check: v => /^[0-9a-fA-F-]{36}$/.test(v) || { level: 'warn', msg: 'Host IDs are normally UUIDs' } },
            ],
          },
        ],
      },
      {
        id: 'vcenter', title: '3. vCenter',
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
        id: 'cluster', title: '4. Cluster and storage', show: full,
        fields: [
          { id: 'clusterName', label: 'Cluster name', type: 'text', auto: domAuto('-cl01'), help: 'Name of the first cluster.', api: 'computeSpec.clusterSpecs[].name' },
          { id: 'imageId', label: 'Cluster image ID', type: 'text', help: 'ID of the vSphere Lifecycle Manager cluster image (SDDC Manager &gt; Lifecycle Management &gt; Image Management, or <code>GET /v1/personalities</code>). Required for vCenter 9.0 and later.', api: 'computeSpec.clusterSpecs[].clusterImageId' },
          { id: 'evc', label: 'EVC mode', type: 'select', def: '', options: [{ v: '', l: 'Disabled' }].concat(['INTEL_SKYLAKE', 'INTEL_CASCADELAKE', 'INTEL_ICELAKE', 'INTEL_SAPPHIRERAPIDS', 'AMD_ZEN', 'AMD_ZEN2', 'AMD_ZEN3', 'AMD_ZEN4'].map(v => ({ v, l: v }))), help: 'Enhanced vMotion Compatibility baseline.', api: 'computeSpec.clusterSpecs[].advancedOptions.evcMode' },
          { id: 'datastoreName', label: 'Datastore name', type: 'text', maxLen: 80, req: true, auto: (s, g) => g('clusterName') ? g('clusterName') + '-ds-' + (isVsan(s) ? 'vsan01' : s.storage === 'nfs' ? 'nfs01' : 'vmfs01') : '', help: 'Datastore name (required for Day-N operations).', api: 'computeSpec.clusterSpecs[].datastoreSpec.vsanDatastoreSpec.datastoreName' },
          { id: 'ftt', label: 'Failures to tolerate', type: 'select', options: C.ftt.concat([{ v: '3', l: '3 failures (RAID-1 mirroring)', d: 'Tolerates three host failures. Requires at least 7 hosts.' }]), def: '1', show: s => s.storage === 'vsan-osa', help: 'vSAN OSA failures to tolerate.', api: 'computeSpec.clusterSpecs[].datastoreSpec.vsanDatastoreSpec.failuresToTolerate' },
          { id: 'dedup', label: 'Deduplication and compression', type: 'checkbox', show: s => s.storage === 'vsan-osa', help: 'All-flash vSAN OSA only.', api: 'computeSpec.clusterSpecs[].datastoreSpec.vsanDatastoreSpec.dedupAndCompressionEnabled' },
          { id: 'esaAutoClaim', label: 'Allow auto claim of HCL incompatible disks', type: 'checkbox', show: isEsa, help: 'Lets vSAN ESA claim non-certified disks (labs only).', api: 'computeSpec.clusterSpecs[].datastoreSpec.vsanDatastoreSpec.esaConfig.skipHclAutoDiskClaim' },
          { id: 'dit', label: 'vSAN data-in-transit encryption', type: 'checkbox', show: isVsan, rerender: true, help: 'Encrypt vSAN traffic between hosts.', api: 'computeSpec.clusterSpecs[].datastoreSpec.vsanDatastoreSpec.encryptionConfig.dataInTransitConfig.enable' },
          { id: 'rekey', label: 'Rekey interval', type: 'select', options: C.rekey, def: '1440', show: s => isVsan(s) && s.dit, rerender: true, help: 'Key rotation interval.' },
          { id: 'rekeyCustom', label: 'Custom rekey interval (minutes)', type: 'text', fmt: 'int', req: true, show: s => isVsan(s) && s.dit && s.rekey === 'custom', help: '30 - 10080 minutes.', check: v => (Number(v) >= 30 && Number(v) <= 10080) || 'Between 30 and 10080 minutes' },
          { id: 'nfsServer', label: 'NFS server', type: 'text', fmt: 'ipOrFqdn', req: true, show: s => s.storage === 'nfs', ph: '10.13.15.4', help: 'NFS v3 server.', api: 'computeSpec.clusterSpecs[].datastoreSpec.nfsDatastoreSpecs[].nasVolume.serverName[]' },
          { id: 'nfsPath', label: 'NFS share path', type: 'text', req: true, show: s => s.storage === 'nfs', ph: '/sfo-w01-cl01-ds-nfs01-share', help: 'Exported path.', check: v => v.startsWith('/') || 'Path must start with /', api: 'computeSpec.clusterSpecs[].datastoreSpec.nfsDatastoreSpecs[].nasVolume.path' },
        ],
      },
      {
        id: 'vds', title: '5. Distributed switches', show: full,
        intro: 'Host management (vmk0) stays on the existing ESX management VLAN; the port group is created on switch 1.',
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
      {
        id: 'nsx', title: '6. NSX Manager',
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
          { id: 'nsxMode', label: 'Host switch operational mode', type: 'select', options: C.nsxMode, def: 'default', show: full, help: 'NSX datapath mode on the hosts.', api: API + '.nsxtSwitchConfig.hostSwitchOperationalMode' },
          { id: 'overlayTz', label: 'Overlay transport zone name', type: 'text', show: s => full(s) && fullStack(s), auto: (s, g) => g('nsxVip') ? 'overlay-tz-' + N.shortName(g('nsxVip')) : '', help: 'NSX overlay transport zone.', api: API + '.nsxtSwitchConfig.transportZones[].name' },
          { id: 'vlanTzOn', label: 'Transport zone type: NSX-VLAN', type: 'checkbox', def: true, rerender: true, show: full, help: 'Workbook "Transport Zone Type: NSX-VLAN". Attach a VLAN transport zone to the NSX switch (needed for VLAN-backed segments, Edge uplinks).' },
          { id: 'vlanTz', label: 'VLAN transport zone name', type: 'text', def: 'nsx-vlan-transportzone-0', show: s => full(s) && s.vlanTzOn, help: 'NSX VLAN transport zone.', api: API + '.nsxtSwitchConfig.transportZones[].name' },
          { id: 'vpcType', label: 'VPC network configuration', type: 'select', options: C.vpcType, def: 'full', rerender: true, help: 'NSX VPC model.', api: 'nsxTSpec.vpcSpec.vpcNetworkConfigurationType' },
          { id: 'vpcConn', label: 'Network connectivity', type: 'select', options: C.vpcConnectivity, def: 'centralized', rerender: true, show: fullStack, help: 'External connectivity for VPCs.', api: 'nsxTSpec.vpcSpec.dtgwSpec' },
        ],
      },
      {
        id: 'tep', title: '7. Host overlay (TEP)', show: s => full(s) && fullStack(s),
        fields: [
          { id: 'tepVlan', label: 'Host overlay VLAN ID', type: 'text', fmt: 'vlan', req: true, ph: '1314', help: 'VLAN for host TEPs (transport VLAN of the uplink profile).', api: 'computeSpec.clusterSpecs[].networkSpec.nsxClusterSpec.nsxTClusterSpec.uplinkProfiles[].transportVlan' },
          { id: 'tepMode', label: 'TEP IP assignment', type: 'select', options: C.tepMode, def: 'pool', rerender: true, help: 'How host TEPs get IPs.' },
          { id: 'tepPoolName', label: 'IP pool name', type: 'text', show: s => s.tepMode === 'pool', auto: domAuto('-cl01-tep01'), pattern: '^[a-zA-Z0-9-_]+$', patternMsg: 'Letters, digits, - and _ only', help: 'Name of the NSX TEP IP pool. To reuse an existing pool, enter its name and leave the range empty.', api: 'computeSpec.clusterSpecs[].networkSpec.nsxClusterSpec.nsxTClusterSpec.ipAddressPoolsSpec[].name' },
          { id: 'tepGw', label: 'Gateway (CIDR notation)', type: 'text', fmt: 'gwcidr', req: s => s.tepMode === 'pool' && !s.tepReuse, show: s => s.tepMode === 'pool' && !s.tepReuse, ph: '10.13.14.1/24', help: 'TEP subnet gateway with prefix.', api: 'computeSpec.clusterSpecs[].networkSpec.nsxClusterSpec.nsxTClusterSpec.ipAddressPoolsSpec[].subnets[].gateway' },
          { id: 'tepStart', label: 'IP pool start', type: 'text', fmt: 'ipv4', req: s => s.tepMode === 'pool' && !s.tepReuse, show: s => s.tepMode === 'pool' && !s.tepReuse, ph: '10.13.14.101', help: 'First TEP address.', api: 'computeSpec.clusterSpecs[].networkSpec.nsxClusterSpec.nsxTClusterSpec.ipAddressPoolsSpec[].subnets[].ipAddressPoolRanges[].start' },
          { id: 'tepEnd', label: 'IP pool end', type: 'text', fmt: 'ipv4', req: s => s.tepMode === 'pool' && !s.tepReuse, show: s => s.tepMode === 'pool' && !s.tepReuse, ph: '10.13.14.132', help: 'Last TEP address.', api: 'computeSpec.clusterSpecs[].networkSpec.nsxClusterSpec.nsxTClusterSpec.ipAddressPoolsSpec[].subnets[].ipAddressPoolRanges[].end' },
          { id: 'tepReuse', label: 'Re-use an existing IP pool', type: 'checkbox', show: s => s.tepMode === 'pool', rerender: true, help: 'Reference an IP pool that already exists in this NSX instance (only the name is sent).' },
          { id: 'uplinkProfile', label: 'NSX uplink profile name', type: 'text', auto: domAuto('-cl01-uplink-profile01'), help: 'Uplink profile created in NSX for the hosts.', api: 'computeSpec.clusterSpecs[].networkSpec.nsxClusterSpec.nsxTClusterSpec.uplinkProfiles[].name' },
          { id: 'netProfile', label: 'Network profile name', type: 'text', auto: domAuto('-cl01-network-profile01'), help: 'SDDC Manager network profile that binds the switch, uplink profile and IP pool.', api: 'computeSpec.clusterSpecs[].networkSpec.networkProfiles[].name' },
          { id: 'nsxTeam', label: 'NSX teaming policy', type: 'select', options: C.nsxTeaming, def: 'LOADBALANCE_SRCID', help: 'Teaming in the uplink profile. A LAG always uses failover order.', api: 'computeSpec.clusterSpecs[].networkSpec.nsxClusterSpec.nsxTClusterSpec.uplinkProfiles[].teamings[].policy' },
          { id: 'nsxU1', label: 'Active uplink uplink-1', type: 'select', options: STATE.slice(0, 2), def: 'Active', help: 'Workbook "Active Uplink uplink-1". Standby is used with failover order.', api: 'computeSpec.clusterSpecs[].networkSpec.nsxClusterSpec.nsxTClusterSpec.uplinkProfiles[].teamings[].activeUplinks' },
          { id: 'nsxU2', label: 'Active uplink uplink-2', type: 'select', options: STATE.slice(0, 2), def: 'Active', help: 'Workbook "Active Uplink uplink-2".', api: 'computeSpec.clusterSpecs[].networkSpec.nsxClusterSpec.nsxTClusterSpec.uplinkProfiles[].teamings[].standByUplinks' },
        ],
      },
      {
        id: 'dtgw', title: '8. Distributed connectivity', show: distributed,
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
        id: 'sup', title: '9. vSphere Supervisor', show: s => full(s) && sup(s),
        intro: 'Single-zone vSphere Supervisor with NSX VPC networking.',
        fields: [
          { id: 'supName', label: 'Supervisor name', type: 'text', auto: domAuto('-sn01'), help: 'Name of the Supervisor.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.supervisorName' },
          { id: 'zoneName', label: 'vSphere zone name', type: 'text', req: true, auto: domAuto('-zn01'), help: 'vSphere zone created for the cluster.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.zoneName' },
          { id: 'svcCidr', label: 'Service CIDR', type: 'text', fmt: 'netcidr', req: true, def: '172.29.0.0/16', help: 'Kubernetes service CIDR.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.serviceCidr' },
          { id: 'cpStart', label: 'Control plane IP range start', type: 'text', fmt: 'ipv4', req: true, ph: '10.13.10.201', help: 'First control plane VM IP (5 addresses recommended).', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.managementNetwork.controlPlaneIpRange.startIpAddress' },
          { id: 'cpEnd', label: 'Control plane IP range end', type: 'text', fmt: 'ipv4', req: true, ph: '10.13.10.205', help: 'Last control plane VM IP.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.managementNetwork.controlPlaneIpRange.endIpAddress' },
          { id: 'supUseMgmt', label: 'Use ESX management VMkernel settings', type: 'checkbox', def: false, rerender: true, help: 'Put the control plane on the host management network instead of a separate VLAN.' },
          { id: 'supVlan', label: 'Management VLAN', type: 'text', fmt: 'vlan', req: true, show: s => !s.supUseMgmt, ph: '1310', help: 'VLAN of the Supervisor management network.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.managementNetwork.details.vlanId' },
          { id: 'supGw', label: 'Management gateway CIDR', type: 'text', fmt: 'gwcidr', req: true, show: s => !s.supUseMgmt, ph: '10.13.10.1/24', help: 'Gateway with prefix of the Supervisor management network.', api: ['computeSpec.clusterSpecs[].supervisorActivationSpec.managementNetwork.details.gateway', 'computeSpec.clusterSpecs[].supervisorActivationSpec.managementNetwork.details.netMask'] },
          { id: 'supDns', label: 'Workload DNS servers', type: 'text', req: true, fmt: 'ipv4', list: true, ph: '10.11.10.4,10.11.10.5', help: 'Comma separated DNS servers.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.vpcNetwork.dnsServers' },
          { id: 'supNtp', label: 'Workload NTP servers', type: 'text', req: true, fmt: 'ipOrFqdn', list: true, ph: 'ntp0.sfo.rainpole.io,ntp1.sfo.rainpole.io', help: 'Comma separated NTP servers.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.vpcNetwork.ntpServers' },
          { id: 'supPrivCidr', label: 'Private (transit gateway) CIDR', type: 'text', fmt: 'netcidr', def: '172.30.0.0/16', show: distributed, help: 'Private CIDR for VPCs when using distributed connectivity.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.vpcNetwork.privateCidr' },
          { id: 'nsxProject', label: 'NSX project path', type: 'text', help: 'Optional. Only when using an existing NSX instance.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.vpcNetwork.nsxProject' },
          { id: 'vpcProfile', label: 'VPC connectivity profile', type: 'text', help: 'Optional. Only when using an existing NSX instance.', api: 'computeSpec.clusterSpecs[].supervisorActivationSpec.vpcNetwork.nsxVpcConnectivityProfile' },
        ],
      },
    ],
  };

  function layoutText(s) {
    const rows = [];
    for (let i = 1; i <= vdsCount(s); i++) {
      const items = TRAFFIC.filter(t => t.show(s) && vdsOf(s, t.k) === i).map(t => t.label);
      if (vdsOf(s, 'nsx') === i) items.push('NSX');
      rows.push('<b>Switch ' + i + ':</b> ' + (items.join(', ') || '<i>nothing assigned</i>'));
    }
    return rows.join('<br>');
  }

  // ---------- rules ----------
  form.rules = function (s, g) {
    const out = [];
    if (s.nsxInstance === 'join') out.push({ level: 'info', field: 'nsxInstance', msg: 'Joining an existing NSX instance: the NSX values must be those of the existing instance' });
    if (!full(s)) return out;
    const hosts = s.hosts.filter(h => (h.fqdn || '').trim());
    if (s.storage === 'vsan-osa' && s.ftt === '3' && hosts.length < 7) out.push({ level: 'error', field: 'hosts', msg: 'vSAN OSA with FTT=3 needs at least 7 hosts' });
    if (s.secondary === 'client' && s.storage !== 'vsan-max') out.push({ level: 'error', field: 'secondary', msg: 'vSAN storage client network requires vSAN Storage Cluster as principal storage' });
    if (s.secondary === 'nfs' && s.storage === 'nfs') out.push({ level: 'error', field: 'secondary', msg: 'Secondary NFS network is not available when NFS is the principal storage' });
    if (s.nsxTeam === 'FAILOVER_ORDER' && s.nsxU1 === 'Active' && s.nsxU2 === 'Active') out.push({ level: 'warn', field: 'nsxU2', msg: 'NSX failover order with two active uplinks; set one to Standby' });
    if (s.nsxU1 !== 'Active' && s.nsxU2 !== 'Active') out.push({ level: 'error', field: 'nsxU1', msg: 'NSX teaming needs at least one active uplink' });
    if (s.pgAdvanced) {
      for (const t of TRAFFIC) {
        if (!t.show(s)) continue;
        if (s['u1_' + t.k] !== 'Active' && s['u2_' + t.k] !== 'Active') out.push({ level: 'error', field: 'u1_' + t.k, msg: t.label + ' port group needs at least one Active uplink' });
        if (s['team_' + t.k] === 'failover_explicit' && s['u1_' + t.k] === 'Active' && s['u2_' + t.k] === 'Active') out.push({ level: 'warn', field: 'u2_' + t.k, msg: t.label + ': explicit failover with two active uplinks; set one to Standby' });
      }
    }
    if (isVsan(s) && hosts.length < 3) out.push({ level: 'error', field: 'hosts', msg: 'vSAN needs at least 3 hosts' });
    if (s.storage === 'vsan-osa' && s.ftt === '2' && hosts.length < 5) out.push({ level: 'error', field: 'hosts', msg: 'vSAN OSA with FTT=2 needs at least 5 hosts' });
    const seen = {};
    s.hosts.forEach((h, i) => {
      const k = (h.fqdn || '').trim().toLowerCase();
      if (k && seen[k]) out.push({ level: 'error', field: 'hosts.' + i + '.fqdn', msg: 'Duplicate host ' + k });
      seen[k] = 1;
    });
    const missingIds = hosts.filter(h => !(h.id || '').trim()).length;
    if (missingIds) out.push({ level: 'warn', field: 'hosts', msg: missingIds + ' host(s) have no SDDC Manager host ID; the domain JSON contains placeholders until you commission the hosts and paste the IDs' });
    if (!(s.poolId || '').trim() && s.poolMode === 'reuse') out.push({ level: 'info', field: 'poolId', msg: 'Re-using a network pool: enter the existing pool ID or replace the placeholder in the commissioning JSON' });
    else if (!(s.poolId || '').trim()) out.push({ level: 'info', field: 'poolId', msg: 'Network pool ID is empty; the commissioning JSON contains a placeholder (the UI variant uses the pool name instead)' });
    if (!(s.imageId || '').trim()) out.push({ level: 'warn', field: 'imageId', msg: 'Cluster image ID is empty; it is required for vCenter 9.0 and later' });

    const n = hosts.length;
    const poolNets = [['vmotion', 'vMotion', () => true], ['vsan', 'vSAN', isVsan], ['nfs', 'NFS', nfsNet], ['vsanext', 'vSAN storage client', clientNet]];
    if (createPool(s)) {
      for (const [k, label, on] of poolNets) {
        if (on(s) && s[k + 'Mode'] !== 'dhcp') C.rangeRules(out, { label, gw: s[k + 'Gw'], start: s[k + 'Start'], end: s[k + 'End'], fieldStart: k + 'Start', fieldEnd: k + 'End', need: n, needMsg: 'needs one per host (' + n + ')' });
      }
    }
    if (fullStack(s) && s.tepMode === 'pool' && !s.tepReuse) {
      const i = vdsOf(s, 'nsx');
      const need = s['vds' + i + 'Type'] === 'lag' ? n : n * (C.list(s['vds' + i + 'Nics']).length || 2);
      C.rangeRules(out, { label: 'TEP pool', gw: s.tepGw, start: s.tepStart, end: s.tepEnd, fieldStart: 'tepStart', fieldEnd: 'tepEnd', need, needMsg: 'needs ' + need + ' (one per host uplink)' });
    }
    if (sup(s)) {
      const cnt = C.rangeRules(out, { label: 'Supervisor control plane', gw: s.supUseMgmt ? null : s.supGw, start: s.cpStart, end: s.cpEnd, fieldStart: 'cpStart', fieldEnd: 'cpEnd', need: 3, needMsg: 'needs at least 3 (5 recommended)' });
      if (cnt && cnt < 5) out.push({ level: 'info', field: 'cpEnd', msg: 'Supervisor control plane range has ' + cnt + ' addresses; 5 are recommended for upgrades' });
      if (!fullStack(s)) out.push({ level: 'warn', field: 'vpcType', msg: 'vSphere Supervisor with NSX VPC networking requires Full Stack VPC' });
    }
    const nets = [['vmotion', 'vMotion'], ['vsan', 'vSAN'], ['nfs', 'NFS'], ['vsanext', 'vSAN storage client'], ['tep', 'TEP'], ['dtgw', 'DTGW']].filter(([k]) => {
      if (k === 'tep') return fullStack(s) && s.tepMode === 'pool' && !s.tepReuse;
      if (k === 'dtgw') return distributed(s);
      const pn = poolNets.find(x => x[0] === k);
      return createPool(s) && pn[2](s) && s[k + 'Mode'] !== 'dhcp';
    });
    for (let i = 0; i < nets.length; i++) {
      for (let j = i + 1; j < nets.length; j++) {
        if (N.cidrsOverlap(s[nets[i][0] + 'Gw'], s[nets[j][0] + 'Gw'])) out.push({ level: 'error', field: nets[j][0] + 'Gw', msg: nets[j][1] + ' subnet overlaps ' + nets[i][1] });
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
      for (const t of TRAFFIC) {
        if (!t.show(s) || vdsOf(s, t.k) !== i || t.k === 'mgmt') continue;
        const m = Number(s[t.k + 'Mtu']);
        if (m && mtu && m > mtu) out.push({ level: 'error', field: t.k + 'Mtu', msg: t.label + ' MTU ' + m + ' exceeds switch ' + i + ' MTU ' + mtu });
      }
      if (fullStack(s) && vdsOf(s, 'nsx') === i && mtu && mtu < 1600) out.push({ level: 'error', field: 'vds' + i + 'Mtu', msg: 'Switch ' + i + ' carries NSX overlay and needs MTU 1600 or higher' });
    }
    if (s.autoPw) out.push({ level: 'info', msg: 'vCenter / NSX passwords are omitted and will be generated by SDDC Manager' });
    return out;
  };

  // ---------- builders ----------
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

  form.build = function (s, g) {
    const files = [];
    const withPw = !s.autoPw;
    const storageType = s.storage === 'vsan-max' ? 'VSAN_MAX' : C.storageTypeCommission[s.storage];
    if (!full(s)) return [domainFile(s, g, null, withPw)];

    // 1. network pool
    const networks = [poolNetwork(s, 'VMOTION', 'vmotion')];
    if (isVsan(s)) networks.push(poolNetwork(s, 'VSAN', 'vsan'));
    if (nfsNet(s)) networks.push(poolNetwork(s, 'NFS', 'nfs'));
    if (clientNet(s)) networks.push(poolNetwork(s, 'VSAN_EXTERNAL', 'vsanext'));
    if (createPool(s)) files.push({
      name: (g('domainName') || 'wld') + '-1-network-pool.json', title: 'Network pool', json: { name: g('poolName'), networks },
      method: 'POST', endpoint: '/v1/network-pools', note: 'Or SDDC Manager UI: Network Settings &gt; Network Pool.',
      schema: { api: 'sddc-manager-api', type: 'NetworkPool' },
    });

    // 2. host commissioning
    const hostRows = s.hosts.filter(h => (h.fqdn || '').trim());
    const commission = hostRows.map(h => {
      const o = { fqdn: h.fqdn.trim(), username: 'root', password: s.esxPw, storageType, networkPoolId: (s.poolId || '').trim() || POOL_ID_PH, networkPoolName: g('poolName') };
      if (isEsa(s) && s.skipHcl) o.skipHclCompatibilityPrecheck = true;
      return o;
    });
    files.push({
      name: (g('domainName') || 'wld') + '-2-commission-hosts-api.json', title: 'Commission hosts (API)', json: commission,
      method: 'POST', endpoint: '/v1/hosts  (validate first: POST /v1/hosts/validations)',
      schema: { api: 'sddc-manager-api', type: 'HostCommissionSpec' },
    });
    files.push({
      name: (g('domainName') || 'wld') + '-2-commission-hosts-ui.json', title: 'Commission hosts (UI import)',
      json: { hosts: commission.map(h => ({ fqdn: h.fqdn, username: h.username, storageType: h.storageType, password: h.password, networkPoolName: h.networkPoolName })) },
      note: 'SDDC Manager UI: Hosts &gt; Commission Hosts &gt; Import (JSON).',
    });

    // 3. domain
    const nsxIdx = vdsOf(s, 'nsx');
    const vmNics = [];
    for (let i = 1; i <= vdsCount(s); i++) {
      const lag = lagOf(s, g, i);
      C.list(s['vds' + i + 'Nics']).forEach((id, n) => vmNics.push({ id, vdsName: g('vds' + i + 'Name'), uplink: lag ? lag + '-' + n : 'uplink' + (n + 1) }));
    }
    const hostSpecs = hostRows.map(h => ({ id: (h.id || '').trim() || HOST_ID_PH, hostName: h.fqdn.trim(), hostNetworkSpec: { vmNics } }));

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
      const teaming = lag
        ? { policy: 'FAILOVER_ORDER', activeUplinks: [lag], standByUplinks: [] }
        : { policy: s.nsxTeam, activeUplinks: up.filter((_, n) => (n === 0 ? s.nsxU1 : n === 1 ? s.nsxU2 : 'Active') === 'Active'), standByUplinks: up.filter((_, n) => (n === 0 ? s.nsxU1 : n === 1 ? s.nsxU2 : 'Active') === 'Standby') };
      const tcs = { uplinkProfiles: [{ name: g('uplinkProfile'), transportVlan: C.int(s.tepVlan), teamings: [teaming] }] };
      if (s.tepMode === 'pool') {
        const ip = { name: g('tepPoolName') };
        if (!s.tepReuse) {
          const c = N.parseCidr(s.tepGw);
          ip.subnets = [{ cidr: c ? c.cidr : '', gateway: c ? c.ip : '', ipAddressPoolRanges: [{ start: s.tepStart, end: s.tepEnd }] }];
        }
        tcs.ipAddressPoolsSpec = [ip];
      }
      networkSpec.nsxClusterSpec = { nsxTClusterSpec: tcs };
      const map = lag ? [{ vdsUplinkName: lag, nsxUplinkName: lag }] : up.map(u => ({ vdsUplinkName: u, nsxUplinkName: u }));
      const hsc = { vdsName: g('vds' + nsxIdx + 'Name'), uplinkProfileName: g('uplinkProfile'), vdsUplinkToNsxUplink: map };
      if (s.tepMode === 'pool') hsc.ipAddressPoolName = g('tepPoolName');
      networkSpec.networkProfiles = [{ name: g('netProfile'), isDefault: true, nsxtHostSwitchConfigs: [hsc] }];
    } else {
      networkSpec.nsxClusterSpec = { nsxTClusterSpec: { overlayVtepSpec: { vtepType: 'NO_IP' } } };
    }

    const datastoreSpec = {};
    if (isVsan(s)) {
      const v = { datastoreName: g('datastoreName') };
      if (isEsa(s)) {
        v.esaConfig = { enabled: true };
        if (s.storage === 'vsan-max') v.esaConfig.vsanMaxConfig = { enableVsanMax: true, enableVsanExternalNetwork: clientNet(s) };
        if (s.esaAutoClaim) v.esaConfig.skipHclAutoDiskClaim = true;
      } else {
        v.esaConfig = { enabled: false };
        v.failuresToTolerate = Number(s.ftt);
        v.dedupAndCompressionEnabled = !!s.dedup;
      }
      v.encryptionConfig = { dataInTransitConfig: { enable: !!s.dit } };
      if (s.dit) v.encryptionConfig.dataInTransitConfig.rekeyInterval = Number(s.rekey === 'custom' ? s.rekeyCustom : s.rekey);
      datastoreSpec.vsanDatastoreSpec = v;
    } else if (s.storage === 'nfs') {
      datastoreSpec.nfsDatastoreSpecs = [{ datastoreName: g('datastoreName'), nasVolume: { serverName: [g('nfsServer')], path: g('nfsPath'), readOnly: false } }];
    } else {
      datastoreSpec.vmfsDatastoreSpec = { fcSpec: [{ datastoreName: g('datastoreName') }] };
    }

    const cluster = {
      name: g('clusterName'),
      clusterImageId: (s.imageId || '').trim() || IMAGE_PH,
      hostSpecs,
      datastoreSpec,
      networkSpec,
    };
    if (s.evc) cluster.advancedOptions = { evcMode: s.evc };

    if (sup(s)) {
      const cidr = N.parseCidr(g('svcCidr'));
      const sa = {
        supervisorName: g('supName'),
        zoneName: g('zoneName'),
        serviceCidr: cidr ? { address: cidr.network, prefix: cidr.prefix } : null,
        managementNetwork: { controlPlaneIpRange: { startIpAddress: s.cpStart, endIpAddress: s.cpEnd } },
        vpcNetwork: { dnsServers: C.list(s.supDns), ntpServers: C.list(s.supNtp) },
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

    files.push(domainFile(s, g, cluster, withPw));
    return files;
  };

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

  // ---------- import ----------
  form.detect = j => j && !Array.isArray(j) && !!j.vcenterSpec && (!!j.computeSpec || (j.domainName !== undefined && !!j.nsxTSpec));
  form.rawSchema = () => ({ api: 'sddc-manager-api', type: 'DomainCreationSpec' });
  const KNOWN = ['domainName', 'vcenterSpec', 'computeSpec', 'nsxTSpec', 'ssoDomainSpec', 'deployWithoutLicenseKeys'];

  form.fromJson = function (j) {
    const s = {};
    const notes = [];
    const str = v => (v === undefined || v === null ? '' : String(v));
    s.domainName = str(j.domainName);
    s.deployType = j.computeSpec ? 'full' : 'infra';
    s.noLicense = j.deployWithoutLicenseKeys !== false && j.deployWithoutLicenseKeys !== 'false';
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

    const clusters = (j.computeSpec || {}).clusterSpecs || [];
    if (clusters.length > 1) notes.push('Only the first cluster was imported.');
    const cl = clusters[0] || {};
    s.clusterName = str(cl.name);
    s.imageId = cl.clusterImageId && cl.clusterImageId.indexOf('<--') !== 0 ? cl.clusterImageId : '';
    s.evc = str((cl.advancedOptions || {}).evcMode);
    const hs = cl.hostSpecs || [];
    s.hosts = hs.map(h => ({ fqdn: str(h.hostName || h.hostname), id: str(h.id).indexOf('<--') === 0 ? '' : str(h.id) }));

    const ds = cl.datastoreSpec || {};
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
      const dit = v.encryptionConfig && v.encryptionConfig.dataInTransitConfig;
      s.dit = !!(dit && dit.enable);
      if (dit && dit.rekeyInterval) {
        const r = String(dit.rekeyInterval);
        if (C.rekey.some(o => o.v === r)) s.rekey = r; else { s.rekey = 'custom'; s.rekeyCustom = r; }
      }
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
    const vds = ns.vdsSpecs || [];
    const firstNics = ((hs[0] || {}).hostNetworkSpec || {}).vmNics || [];
    const find = t => vds.findIndex(v => (v.portGroupSpecs || []).some(p => p.transportType === t)) + 1;
    const nsxIdx = vds.findIndex(v => v.nsxtSwitchConfig) + 1 || 1;
    const stIdx = find('VSAN') || find('NFS') || 1;
    const count = vds.length || 1;
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
    vds.slice(0, 3).forEach((v, n) => {
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
    const up = (tcs.uplinkProfiles || [])[0];
    if (up) {
      s.uplinkProfile = str(up.name);
      s.tepVlan = str(up.transportVlan);
      const t = (up.teamings || [])[0];
      if (t && t.policy) {
        s.nsxTeam = t.policy;
        const a = t.activeUplinks || [], b = t.standByUplinks || [];
        s.nsxU1 = b.includes('uplink1') && !a.includes('uplink1') ? 'Standby' : 'Active';
        s.nsxU2 = b.includes('uplink2') && !a.includes('uplink2') ? 'Standby' : 'Active';
      }
    } else if (tcs.geneveVlanId !== undefined) s.tepVlan = str(tcs.geneveVlanId);
    const pool = (tcs.ipAddressPoolsSpec || [])[0];
    if (pool) {
      s.tepMode = 'pool';
      s.tepPoolName = str(pool.name);
      const sub = (pool.subnets || [])[0];
      if (sub) {
        const p = sub.cidr && sub.cidr.indexOf('/') > 0 ? sub.cidr.split('/')[1] : '24';
        s.tepGw = sub.gateway ? sub.gateway + '/' + p : '';
        const r = (sub.ipAddressPoolRanges || [])[0] || {};
        s.tepStart = str(r.start); s.tepEnd = str(r.end);
      } else s.tepReuse = true;
    } else if (s.vpcType === 'full') s.tepMode = 'dhcp';
    const np = (ns.networkProfiles || [])[0];
    if (np) s.netProfile = str(np.name);

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
    notes.push('Network pool and host commissioning values are not part of the domain spec; fill in section 1 and 2 if you need those files.');
    const extra = {};
    for (const k of Object.keys(j)) if (!KNOWN.includes(k)) extra[k] = j[k];
    if (Object.keys(extra).length) notes.push('Fields kept unchanged in the output: ' + Object.keys(extra).join(', '));
    return { state: s, extra, notes };
  };

  form.sample = function () {
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

  App.register(form);
})();
