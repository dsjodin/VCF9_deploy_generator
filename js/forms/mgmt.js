// VCF Installer: new VCF fleet / management domain (SddcSpec, workflowType VCF).
(function () {
  const C = Common;
  const N = Net;

  const isHA = s => s.deployModel === 'ha';
  const isVsan = s => s.storage === 'vsan-esa' || s.storage === 'vsan-osa';
  const fullStack = s => s.vpcType === 'full';
  const sepVmMgmt = s => s.vmMgmtMode === 'separate';
  const sepVcfMgmt = s => s.vcfMgmtMode === 'separate';
  const pw = s => !s.autoPw;
  const custom = s => s.vdsProfile === 'custom';

  // Traffic types that live on the distributed switches.
  const TRAFFIC = [
    { k: 'mgmt', type: 'MANAGEMENT', label: 'ESX management', pg: 'esx-mgmt', show: () => true },
    { k: 'vmmgmt', type: 'VM_MANAGEMENT', label: 'VM management', pg: 'vm-mgmt', show: () => true },
    { k: 'vcfmgmt', type: 'FLEET_MANAGEMENT', label: 'VCF management', pg: 'vcf-mgmt', show: sepVcfMgmt },
    { k: 'vmotion', type: 'VMOTION', label: 'vMotion', pg: 'vmotion', show: () => true },
    { k: 'vsan', type: 'VSAN', label: 'vSAN', pg: 'vsan', show: isVsan },
    { k: 'nfs', type: 'NFS', label: 'NFS', pg: 'nfs', show: s => s.storage === 'nfs' },
  ];
  const STORAGE_K = ['vsan', 'nfs'];

  const PROFILE = {
    default: { count: 1, storage: 1, nsx: 1 },
    storage: { count: 2, storage: 2, nsx: 1 },
    nsx: { count: 2, storage: 1, nsx: 2 },
    'storage-nsx': { count: 3, storage: 2, nsx: 3 },
  };

  function vdsCount(s) {
    return custom(s) ? Number(s.vdsCount) : PROFILE[s.vdsProfile].count;
  }

  // 1-based VDS number carrying a traffic type ('nsx' for overlay).
  function vdsOf(s, k) {
    if (custom(s)) return Math.min(Number(s['vdsFor_' + k]) || 1, vdsCount(s));
    const p = PROFILE[s.vdsProfile];
    if (k === 'nsx') return p.nsx;
    return STORAGE_K.includes(k) ? p.storage : 1;
  }

  const clusterAuto = (s, g) => g('sddcId') ? g('sddcId') + '-cl01' : '';
  const vdsNameAuto = i => (s, g) => g('clusterName') ? g('clusterName') + '-vds0' + i : '';
  const ipRangeOk = v => N.isIPv4(v) || 'Must be an IPv4 address';
  const shortOf = fqdn => N.shortName(fqdn);

  function componentGw(s) {
    if (sepVcfMgmt(s)) return s.vcfMgmtGw;
    if (sepVmMgmt(s)) return s.vmMgmtGw;
    return s.mgmtGw;
  }

  function componentNetLabel(s) {
    if (sepVcfMgmt(s)) return 'VCF management network';
    if (sepVmMgmt(s)) return 'VM management network';
    return 'ESX management network';
  }

  // ---------- field factories ----------
  function fqdnField(id, label, ph, help, api, extra) {
    return Object.assign({ id, label, type: 'text', fmt: 'fqdn', req: true, ph, help, api }, extra || {});
  }

  function pwField(id, label, rule, help, api, extra) {
    return Object.assign({ id, label, type: 'password', req: pw, show: pw, pw: rule, help, api }, extra || {});
  }

  function netFields(p, title, opts) {
    const o = opts || {};
    const fields = [
      { type: 'note', text: '<b>' + title + '</b>' + (o.note ? ' - ' + o.note : ''), show: o.show },
      { id: p + 'Vlan', label: 'VLAN ID', type: 'text', fmt: 'vlan', req: true, ph: o.vlan, show: o.show, help: 'VLAN ID tagged on the port group for this network. Use 0 for an untagged (native) VLAN.', api: o.api ? o.api + '.vlanId' : null },
      { id: p + 'Mtu', label: 'MTU', type: 'text', fmt: 'mtu', req: true, def: o.mtu, show: o.show, help: 'MTU for this VMkernel network. ' + (o.mtu === '9000' ? 'Jumbo frames (9000) recommended; the physical network must support it end-to-end.' : '1500 is standard for management networks.'), api: o.api ? o.api + '.mtu' : null },
      { id: p + 'Gw', label: 'Gateway (CIDR notation)', type: 'text', fmt: 'gwcidr', req: true, ph: o.gw, show: o.show, help: 'Default gateway of the subnet with prefix length, for example <code>10.11.11.1/24</code>. The subnet is derived from this value.', api: o.api ? [o.api + '.gateway', o.api + '.subnet'] : null },
    ];
    if (o.range) {
      fields.push(
        { id: p + 'Start', label: 'IP range start', type: 'text', fmt: 'ipv4', req: true, ph: o.start, show: o.show, help: 'First address of the pool used for host VMkernel adapters on this network. One address per host is required.', api: o.api ? o.api + '.includeIpAddressRanges[].startIpAddress' : null },
        { id: p + 'End', label: 'IP range end', type: 'text', fmt: 'ipv4', req: true, ph: o.end, show: o.show, help: 'Last address of the pool. Size the pool for current hosts plus future expansion.', api: o.api ? o.api + '.includeIpAddressRanges[].endIpAddress' : null });
    }
    return fields;
  }

  function trafficFields() {
    const out = [];
    for (const t of TRAFFIC) {
      const show = s => t.show(s) && !!s.pgAdvanced;
      out.push(
        { type: 'note', text: '<b>Port group: ' + t.label + '</b>', show },
        { id: 'pg_' + t.k, label: 'Port group name', type: 'text', show, maxLen: 80, auto: (s, g) => { const v = vdsName(s, g, vdsOf(s, t.k)); return v ? v + '-pg-' + t.pg : ''; }, help: 'Distributed port group created for ' + t.label + ' traffic.', api: 'networkSpecs[].portGroupKey' },
        { id: 'team_' + t.k, label: 'Load balancing', type: 'select', options: C.pgTeaming, show, help: 'Teaming policy of the port group. Ignored when the switch uses a LAG (explicit failover with the LAG as active uplink is used).', api: 'networkSpecs[].teamingPolicy' },
        { id: 'act_' + t.k, label: 'Active uplinks', type: 'text', show, auto: (s, g) => uplinkNames(s, g, vdsOf(s, t.k)).join(','), help: 'Comma separated active uplinks, e.g. <code>uplink1,uplink2</code>. For explicit failover put the preferred uplink here and the other in standby.', api: 'networkSpecs[].activeUplinks' },
        { id: 'stby_' + t.k, label: 'Standby uplinks', type: 'text', show, help: 'Comma separated standby uplinks (optional).', api: 'networkSpecs[].standbyUplinks' },
      );
    }
    return out;
  }

  function vdsName(s, g, i) { return g('vds' + i + 'Name'); }

  function uplinkNames(s, g, i) {
    return C.list(s['vds' + i + 'Nics']).map((_, n) => 'uplink' + (n + 1));
  }

  // ---------- form definition ----------
  const form = {
    id: 'mgmt',
    tab: 'Management Domain',
    title: 'VCF Installer - New VCF Fleet (Management Domain)',
    intro: 'Generates the JSON specification you upload in the <b>VCF Installer</b> (Deploy a new VCF fleet &gt; Upload JSON) or post to <code>POST /v1/sddcs</code>. Fields marked <span class="req">*</span> are required. Grey text shows the workbook sample or the value that will be generated automatically.',
    schema: { api: 'vcf-installer-api', root: 'SddcSpec' },
    sections: [
      {
        id: 'general', title: 'General information',
        intro: 'Basic identity of the new VCF instance. Software depot, proxy and download token are configured in the VCF Installer UI and are not part of the JSON.',
        fields: [
          { id: 'vcfInstanceName', label: 'VCF instance name', type: 'text', req: true, minLen: 3, maxLen: 300, ph: 'San Francisco', help: 'Display name of this VCF instance in VCF Operations and the fleet. Minimum 3 characters.', api: 'vcfInstanceName' },
          { id: 'sddcId', label: 'Management domain name', type: 'text', req: true, ph: 'sfo-m01', pattern: '^[a-zA-Z0-9-]{3,20}$', patternMsg: '3-20 characters: letters, digits and hyphens', help: 'Name of the management domain (SDDC ID). 3-20 characters, letters, digits and hyphens only. Used as prefix for several generated object names.', api: 'sddcId' },
          { id: 'version', label: 'VCF version', type: 'text', def: '9.1.1.0', req: true, pattern: '^\\d+\\.\\d+\\.\\d+\\.\\d+$', patternMsg: 'Use the four-part version, e.g. 9.1.1.0', help: 'VCF release to deploy, exactly as listed in the VCF Installer depot (for example <code>9.1.1.0</code>). The binaries for this version must be downloaded to the installer.', api: 'version' },
          { id: 'ceip', label: 'Join the Customer Experience Improvement Program (CEIP)', type: 'checkbox', def: true, help: 'Send anonymous product usage data to Broadcom. Applies to newly deployed components only.', api: 'ceipEnabled' },
          { id: 'autoPw', label: 'Auto-generate passwords', type: 'checkbox', def: false, rerender: true, help: 'When enabled, the installer generates all appliance passwords and the JSON omits them (ESX root password is still required). Retrieve generated passwords from SDDC Manager / VCF Operations after deployment.' },
          { id: 'skipThumb', label: 'Skip ESX thumbprint validation', type: 'checkbox', def: false, rerender: true, help: 'When off (recommended) you can enter the SSL thumbprint of each host; if you leave thumbprints empty the installer shows them for you to accept. Turn on only in labs.', api: 'skipEsxThumbprintValidation' },
          { id: 'skipGwPing', label: 'Skip gateway ping validation', type: 'checkbox', def: false, help: 'Skips the check that every network gateway answers ping. Enable only when gateways block ICMP.', api: 'skipGatewayPingValidation' },
        ],
      },
      {
        id: 'sizing', title: 'Deployment model and sizing',
        intro: 'The deployment model applies to newly deployed VCF Operations, VCF Automation and NSX Manager appliances.',
        fields: [
          { id: 'deployModel', label: 'Deployment model', type: 'select', options: C.deployModel, def: 'ha', rerender: true, help: 'Controls the number of NSX Manager, VCF Operations and VCF Automation nodes.' },
          { id: 'opsSize', label: 'VCF Operations size', type: 'select', options: C.opsSize, def: 'medium', help: 'Size of each VCF Operations analytics node. xsmall is not allowed for the management domain in 9.1.', api: 'vcfOperationsSpec.applianceSize' },
          { id: 'collectorSize', label: 'VCF Operations collector (cloud proxy) size', type: 'select', options: C.collectorSize, def: 'standard', help: 'Size of the VCF Operations collector deployed in this instance.', api: 'vcfOperationsCollectorSpec.applianceSize' },
          { id: 'vcSize', label: 'vCenter size', type: 'select', options: C.vcSize, def: 'small', help: 'Management vCenter appliance size. Tiny is not supported for the management domain in 9.1.', api: 'vcenterSpec.vmSize' },
          { id: 'vcStorage', label: 'vCenter storage size', type: 'select', options: C.vcStorage, def: '', help: 'Disk layout of the management vCenter.', api: 'vcenterSpec.storageSize' },
          { id: 'nsxSize', label: 'NSX Manager size', type: 'select', options: C.nsxSize, def: 'medium', help: 'Form factor of each NSX Manager appliance. Small is not supported for the management domain.', api: 'nsxtSpec.nsxtManagerSize' },
          { id: 'vspSize', label: 'VCF management services size', type: 'select', def: 'auto', options: [
            { v: 'auto', l: 'Automatic (by deployment model)', d: 'medium for High Availability, small for Simple (same as the official JSON generator).' },
            { v: 'small', l: 'small', d: 'Single small services runtime.' },
            { v: 'small_ha', l: 'small_ha', d: 'Small with high availability (management services only).' },
            { v: 'medium', l: 'medium', d: 'Medium services runtime.' },
            { v: 'large', l: 'large', d: 'Large services runtime.' },
          ], help: 'Size of the VCF services runtime cluster that hosts fleet and instance management services (fleet lifecycle, identity broker, SDDC lifecycle, depot, telemetry, Salt).', api: 'vspClusterSpec.size' },
          { id: 'includeAuto', label: 'Deploy VCF Automation now', type: 'checkbox', def: true, rerender: true, help: 'Clear this if you have an existing VCF Automation instance or plan to deploy it later (Day-N). The vcfAutomationSpec is then omitted.' },
          { id: 'autoSize', label: 'VCF Automation size', type: 'select', show: s => s.includeAuto, def: 'medium', options: [
            { v: 'small', l: 'small', d: 'Smallest footprint. With High Availability, small is deployed in Simple mode (no HA).' },
            { v: 'medium', l: 'medium', d: 'Recommended for production with High Availability.' },
            { v: 'large', l: 'large', d: 'Large tenant / catalog scale.' },
          ], help: 'Size of the VCF Automation services runtime.', api: 'vcfAutomationSpec.size' },
        ],
      },
      {
        id: 'netopts', title: 'Network options',
        intro: 'Choose how management networks are laid out. These choices decide which networks you fill in further down.',
        fields: [
          { id: 'vmMgmtMode', label: 'VM management network', type: 'select', rerender: true, def: 'separate', options: [
            { v: 'separate', l: 'Use a separate dedicated network', d: 'Management appliances (vCenter, NSX, SDDC Manager...) get their own VLAN/subnet, separate from the ESX host VMkernel management network. Recommended.' },
            { v: 'esx', l: 'Use ESX management network', d: 'Management appliances share the ESX management VLAN and subnet. The VM management port group is still created with the same VLAN.' },
          ], help: 'Network used by the management appliance VMs.', api: 'networkSpecs[].networkType = VM_MANAGEMENT' },
          { id: 'vcfMgmtMode', label: 'VCF management network', type: 'select', rerender: true, def: 'vm', options: [
            { v: 'vm', l: 'Use VM management network', d: 'VCF Operations, VCF Automation and VCF management services are deployed on the VM management network.' },
            { v: 'separate', l: 'Use a separate dedicated network', d: 'A dedicated FLEET_MANAGEMENT network (VLAN/subnet) for VCF Operations, VCF Automation and the VCF management services.' },
          ], help: 'Network used by the VCF management components (fleet-level services).', api: 'networkSpecs[].networkType = FLEET_MANAGEMENT' },
          { id: 'vpcType', label: 'VPC network configuration', type: 'select', options: C.vpcType, def: 'full', rerender: true, help: 'NSX VPC model for the management domain. This also decides whether the management hosts get NSX TEPs, even if you never create VPCs: Full Stack VPC configures host TEPs (host overlay VLAN and IP pool needed, and AZ2 TEPs when stretching); VLAN backed VPC configures no TEPs. If the management domain will only use VLAN-backed segments, VLAN backed VPC avoids the TEP network.', api: 'nsxtSpec.vpcSpec.vpcNetworkConfigurationType' },
          { id: 'vpcConn', label: 'VPC gateway connectivity', type: 'select', options: C.vpcConnectivity, def: 'centralized', rerender: true, show: fullStack, help: 'How VPCs reach the physical network.', api: 'nsxtSpec.vpcSpec.dtgwSpec' },
        ],
      },
      {
        id: 'storage', title: 'Storage',
        intro: 'Principal storage of the management cluster.',
        fields: [
          { id: 'storage', label: 'Storage type', type: 'select', options: C.storage, def: 'vsan-esa', rerender: true, help: 'Principal storage for the first cluster in the management domain.', api: 'datastoreSpec' },
          { id: 'datastoreName', label: 'Datastore name', type: 'text', maxLen: 80, auto: (s, g) => g('clusterName') ? g('clusterName') + '-ds-' + (isVsan(s) ? 'vsan01' : s.storage === 'nfs' ? 'nfs01' : 'vmfs01') : '', req: s => s.storage === 'fc', help: 'Name of the principal datastore. For VMFS on FC this must be the name of the existing VMFS datastore.', api: ['datastoreSpec.vsanSpec.datastoreName', 'datastoreSpec.nfsDatastoreSpec.datastoreName', 'datastoreSpec.vmfsDatastoreSpec.fcSpec[].datastoreName'] },
          { id: 'esaAutoClaim', label: 'Allow auto claim of HCL incompatible disks', type: 'checkbox', show: s => s.storage === 'vsan-esa', help: 'Lets vSAN ESA claim disks that are not on the vSAN ESA HCL. Use only for labs or when SDDC Manager cannot verify certified disks.', api: 'datastoreSpec.vsanSpec.esaConfig.skipHclAutoDiskClaim' },
          { id: 'ftt', label: 'Failures to tolerate', type: 'select', options: C.ftt, def: '1', show: s => s.storage === 'vsan-osa', help: 'vSAN OSA default storage policy failures to tolerate.', api: 'datastoreSpec.vsanSpec.failuresToTolerate' },
          { id: 'dedup', label: 'Deduplication and compression', type: 'checkbox', show: s => s.storage === 'vsan-osa', help: 'Enable space efficiency on all-flash vSAN OSA disk groups.', api: 'datastoreSpec.vsanSpec.vsanDedup' },
          { id: 'dit', label: 'vSAN data-in-transit encryption', type: 'checkbox', show: isVsan, rerender: true, help: 'Encrypts all vSAN traffic between hosts.', api: 'datastoreSpec.vsanSpec.encryptionConfig.dataInTransitConfig.enable' },
          { id: 'rekey', label: 'Rekey interval', type: 'select', options: C.rekey, def: '1440', show: s => isVsan(s) && s.dit, rerender: true, help: 'How often data-in-transit encryption keys are rotated.', api: 'datastoreSpec.vsanSpec.encryptionConfig.dataInTransitConfig.rekeyInterval' },
          { id: 'rekeyCustom', label: 'Custom rekey interval (minutes)', type: 'text', fmt: 'int', req: true, show: s => isVsan(s) && s.dit && s.rekey === 'custom', ph: '1440', help: 'Rekey interval in minutes (30 - 10080).', check: v => (Number(v) >= 30 && Number(v) <= 10080) || 'Between 30 and 10080 minutes' },
          { id: 'nfsServer', label: 'NFS server IP address', type: 'text', fmt: 'ipOrFqdn', req: true, show: s => s.storage === 'nfs', ph: '10.11.15.200', help: 'NFS v3 server exporting the share.', api: 'datastoreSpec.nfsDatastoreSpec.nasVolume.serverName[]' },
          { id: 'nfsPath', label: 'NFS share path', type: 'text', req: true, show: s => s.storage === 'nfs', ph: '/share/sfo-m01-cl01-ds-nfs01', help: 'Exported path, starting with /.', api: 'datastoreSpec.nfsDatastoreSpec.nasVolume.path', check: v => v.startsWith('/') || 'Path must start with /' },
          { id: 'nfsBind', label: 'Bind NFS datastore to the NFS VMkernel adapter', type: 'checkbox', def: true, show: s => s.storage === 'nfs', help: 'Prevents NFS traffic from leaving through other VMkernel adapters.', api: 'datastoreSpec.nfsDatastoreSpec.nasVolume.enableBindToVmknic' },
        ],
      },
      {
        id: 'dnsntp', title: 'DNS and NTP',
        intro: 'At least one DNS and one NTP server must match the ones configured on the VCF Installer appliance. All FQDNs below must resolve forward and reverse before deployment.',
        fields: [
          { id: 'dnsDomain', label: 'DNS domain (default suffix)', type: 'text', fmt: 'domain', req: true, ph: 'rainpole.io', help: 'Default DNS suffix / search domain for the instance.', api: 'dnsSpec.subdomain' },
          { id: 'dns1', label: 'DNS server 1', type: 'text', fmt: 'ipv4', req: true, ph: '10.11.10.4', help: 'Primary DNS server IP.', api: 'dnsSpec.nameservers[]' },
          { id: 'dns2', label: 'DNS server 2', type: 'text', fmt: 'ipv4', ph: '10.11.10.5', help: 'Secondary DNS server IP (optional, maximum two).', api: 'dnsSpec.nameservers[]' },
          { id: 'ntp1', label: 'NTP server 1', type: 'text', fmt: 'ipOrFqdn', req: true, ph: 'ntp0.sfo.rainpole.io', help: 'NTP server IP or FQDN.', api: 'ntpServers[]' },
          { id: 'ntp2', label: 'NTP server 2', type: 'text', fmt: 'ipOrFqdn', ph: 'ntp1.sfo.rainpole.io', help: 'Second NTP server (optional).', api: 'ntpServers[]' },
        ],
      },
      {
        id: 'hosts', title: 'ESX hosts',
        intro: 'Hosts for the first (management) cluster. Hosts must be installed with the matching ESX version, have the root password below, and resolve in DNS.',
        fields: [
          { id: 'esxPw', label: 'ESX root password', type: 'password', req: true, pw: C.pw.esx, ph: 'VMw@re1!', help: 'Current root password of the ESX hosts (same on all hosts).', api: 'hostSpecs[].credentials.password' },
          {
            id: 'hosts', label: 'Hosts', type: 'rows', min: 2, max: 64, initial: 4, addLabel: 'Add host',
            hint: 'Use "Paste host list" to fill the table from a list of FQDNs.',
            help: 'One row per ESX host. The official JSON generator writes the host FQDN into hostname.',
            columns: [
              { id: 'fqdn', label: 'Host FQDN', type: 'text', fmt: 'fqdn', req: true, ph: (s, g, i) => 'sfo01-m01-r01-esx0' + ((i || 0) + 1) + '.sfo.rainpole.io', help: 'Fully qualified host name of the ESX host.', api: 'hostSpecs[].hostname' },
              { id: 'ssl', label: 'SSL thumbprint (SHA-256)', type: 'text', fmt: 'thumb', show: s => !s.skipThumb, help: 'Optional. SHA-256 fingerprint of the host certificate, e.g. from <code>openssl s_client -connect host:443 | openssl x509 -noout -fingerprint -sha256</code>. Leave empty to accept it in the installer UI.', api: 'hostSpecs[].sslThumbprint' },
            ],
            tools: (s, g, changed) => App.h('button', { type: 'button', class: 'btn small', onclick: () => pasteHosts(s, changed) }, 'Paste host list'),
          },
        ],
      },
      {
        id: 'networks', title: 'Networks',
        intro: 'VLANs and subnets of the management cluster. Gateways are entered with prefix length; subnets are derived automatically.',
        fields: [
          ...netFields('mgmt', 'ESX management network', { vlan: '1111', mtu: '1500', gw: '10.11.11.1/24', api: 'networkSpecs[MANAGEMENT]', note: 'VMkernel vmk0 of the hosts' }),
          ...netFields('vmMgmt', 'VM management network', { vlan: '1110', mtu: '1500', gw: '10.11.10.1/24', show: sepVmMgmt, api: 'networkSpecs[VM_MANAGEMENT]', note: 'vCenter, NSX Managers, SDDC Manager' }),
          ...netFields('vcfMgmt', 'VCF management network', { vlan: '1199', mtu: '1500', gw: '10.11.99.1/24', show: sepVcfMgmt, api: 'networkSpecs[FLEET_MANAGEMENT]', note: 'VCF Operations, Automation, management services' }),
          { type: 'note', text: (s) => '<b>VCF management services IP range</b> - on the ' + componentNetLabel(s) + '. Minimum 12 addresses, 30 recommended for scale-out.' },
          { id: 'vspStart', label: 'Range start', type: 'text', fmt: 'ipv4', req: true, ph: '10.11.99.31', help: 'First IP of the pool used by the VCF services runtime nodes (VCF management services).', api: 'vspClusterSpec.ipv4Pool.ipRange.startIpAddress' },
          { id: 'vspEnd', label: 'Range end', type: 'text', fmt: 'ipv4', req: true, ph: '10.11.99.45', help: 'Last IP of the VCF management services pool.', api: 'vspClusterSpec.ipv4Pool.ipRange.endIpAddress' },
          { type: 'note', text: s => '<b>VCF Automation IP range</b> - on the ' + componentNetLabel(s) + '. ' + (isHA(s) ? 'High Availability: 5 addresses (4 active nodes + 1 used during rolling upgrades).' : 'Simple: 2 addresses (1 node + 1 used during upgrades).'), show: s => s.includeAuto },
          { id: 'autoStart', label: 'Range start', type: 'text', fmt: 'ipv4', req: true, show: s => s.includeAuto, ph: '10.11.99.46', help: 'First IP for VCF Automation runtime nodes.', api: 'vcfAutomationSpec.ipPool[]' },
          { id: 'autoEnd', label: 'Range end', type: 'text', fmt: 'ipv4', req: true, show: s => s.includeAuto, ph: '10.11.99.50', help: 'Last IP for VCF Automation runtime nodes.', api: 'vcfAutomationSpec.ipPool[]' },
          ...netFields('vmotion', 'vMotion network', { vlan: '1112', mtu: '9000', gw: '10.11.12.1/24', range: true, start: '10.11.12.101', end: '10.11.12.116', api: 'networkSpecs[VMOTION]' }),
          ...netFields('vsan', 'vSAN network', { vlan: '1113', mtu: '9000', gw: '10.11.13.1/24', range: true, start: '10.11.13.101', end: '10.11.13.116', show: isVsan, api: 'networkSpecs[VSAN]' }),
          ...netFields('nfs', 'NFS network', { vlan: '1115', mtu: '9000', gw: '10.11.15.1/24', range: true, start: '10.11.15.101', end: '10.11.15.116', show: s => s.storage === 'nfs', api: 'networkSpecs[NFS]' }),
          { type: 'note', text: '<b>Host overlay (NSX TEP) network</b> - MTU is inherited from the distributed switch.', show: fullStack },
          { id: 'tepVlan', label: 'VLAN ID', type: 'text', fmt: 'vlan', req: true, show: fullStack, ph: '1114', help: 'VLAN for host tunnel endpoints (Geneve overlay traffic).', api: 'nsxtSpec.transportVlanId' },
          { id: 'tepMode', label: 'TEP IP assignment', type: 'select', options: C.tepMode, def: 'pool', show: fullStack, rerender: true, help: 'How host TEP interfaces get addresses.' },
          { id: 'tepGw', label: 'Gateway (CIDR notation)', type: 'text', fmt: 'gwcidr', req: true, show: s => fullStack(s) && s.tepMode === 'pool', ph: '10.11.14.1/24', help: 'Gateway of the host overlay subnet with prefix.', api: 'nsxtSpec.ipAddressPoolSpec.subnets[].gateway' },
          { id: 'tepStart', label: 'IP pool start', type: 'text', fmt: 'ipv4', req: true, show: s => fullStack(s) && s.tepMode === 'pool', ph: '10.11.14.101', help: 'First TEP address. Each host uses one TEP per NSX uplink (normally 2).', api: 'nsxtSpec.ipAddressPoolSpec.subnets[].ipAddressPoolRanges[].start' },
          { id: 'tepEnd', label: 'IP pool end', type: 'text', fmt: 'ipv4', req: true, show: s => fullStack(s) && s.tepMode === 'pool', ph: '10.11.14.132', help: 'Last TEP address.', api: 'nsxtSpec.ipAddressPoolSpec.subnets[].ipAddressPoolRanges[].end' },
          { id: 'tepPoolName', label: 'IP pool name', type: 'text', show: s => fullStack(s) && s.tepMode === 'pool', auto: (s, g) => g('sddcId') ? g('sddcId') + '-cl01-tep01' : '', pattern: '^[a-zA-Z0-9-_]+$', patternMsg: 'Letters, digits, - and _ only', help: 'Name of the NSX IP pool for host TEPs.', api: 'nsxtSpec.ipAddressPoolSpec.name' },
          { id: 'poolName', label: 'Management network pool name', type: 'text', auto: (s, g) => g('sddcId') ? g('sddcId') + '-np01' : '', help: 'Name of the SDDC Manager network pool created for the management domain (vMotion / storage IP ranges).', api: 'managementPoolName' },
        ],
      },
      {
        id: 'dtgw', title: 'Distributed transit gateway', show: s => fullStack(s) && s.vpcConn === 'distributed',
        intro: 'Distributed connectivity: VPC external traffic leaves the hosts directly on this VLAN.',
        fields: [
          { id: 'dtgwVlan', label: 'VLAN ID', type: 'text', fmt: 'vlan', req: true, ph: '1198', help: 'VLAN used by the distributed transit gateway.', api: 'nsxtSpec.vpcSpec.dtgwSpec.vlan' },
          { id: 'dtgwGw', label: 'Gateway CIDR', type: 'text', fmt: 'gwcidr', req: true, ph: '10.11.98.1/24', help: 'Physical gateway on the DTGW VLAN, with prefix.', api: 'nsxtSpec.vpcSpec.dtgwSpec.gatewayCidr' },
          { id: 'dtgwExt', label: 'External IP block CIDR', type: 'text', fmt: 'netcidr', req: true, ph: '10.11.97.0/24', help: 'Public/external IP block for VPCs. Required for external connectivity through the DTGW.', api: 'nsxtSpec.vpcSpec.dtgwSpec.externalIpBlockCidr' },
          { id: 'dtgwPriv', label: 'Private TGW IP block CIDR', type: 'text', fmt: 'netcidr', ph: '172.31.0.0/16', help: 'Optional private transit gateway IP block for VPCs.', api: 'nsxtSpec.vpcSpec.dtgwSpec.privateTgwIpBlockCidr' },
        ],
      },
      {
        id: 'vcenter', title: 'vCenter',
        fields: [
          fqdnField('vcFqdn', 'Appliance FQDN', 'sfo-m01-vc01.sfo.rainpole.io', 'FQDN of the management vCenter. Must resolve to an IP on the VM management network.', 'vcenterSpec.vcenterHostname', { maxLen: 63 }),
          { id: 'datacenter', label: 'Datacenter name', type: 'text', auto: (s, g) => g('sddcId') ? g('sddcId') + '-dc01' : '', help: 'vSphere datacenter object name.', api: 'clusterSpec.datacenterName' },
          { id: 'clusterName', label: 'Cluster name', type: 'text', auto: clusterAuto, help: 'Name of the management cluster.', api: 'clusterSpec.clusterName' },
          { id: 'evc', label: 'EVC mode', type: 'select', def: '', options: [{ v: '', l: 'Disabled' }].concat(['INTEL_SKYLAKE', 'INTEL_CASCADELAKE', 'INTEL_ICELAKE', 'INTEL_SAPPHIRERAPIDS', 'AMD_ZEN', 'AMD_ZEN2', 'AMD_ZEN3', 'AMD_ZEN4'].map(v => ({ v, l: v }))), help: 'Enhanced vMotion Compatibility baseline for the cluster. Leave disabled unless you mix CPU generations.', api: 'clusterSpec.clusterEvcMode' },
          { id: 'ssoDomain', label: 'SSO domain', type: 'text', def: 'vsphere.local', fmt: 'domain', req: true, help: 'vCenter Single Sign-On domain. The SSO administrator is administrator@&lt;sso domain&gt;.', api: 'vcenterSpec.ssoDomain' },
          pwField('vcRootPw', 'Root password', C.pw.vcRoot, 'vCenter appliance root password. 15-20 characters with upper, lower, digit and special character.', 'vcenterSpec.rootVcenterPassword', { req: true, show: () => true }),
          pwField('ssoPw', 'SSO administrator password', C.pw.sso, 'Password for administrator@&lt;sso domain&gt;.', 'vcenterSpec.adminUserSsoPassword'),
        ],
      },
      {
        id: 'nsx', title: 'NSX Manager',
        fields: [
          fqdnField('nsxVip', 'Cluster (VIP) FQDN', 'sfo-m01-nsx01.sfo.rainpole.io', 'FQDN of the NSX Manager cluster virtual IP.', 'nsxtSpec.vipFqdn'),
          fqdnField('nsxA', 'Appliance 1 FQDN', 'sfo-m01-nsx01a.sfo.rainpole.io', 'First NSX Manager node.', 'nsxtSpec.nsxtManagers[].hostname'),
          fqdnField('nsxB', 'Appliance 2 FQDN', 'sfo-m01-nsx01b.sfo.rainpole.io', 'Second NSX Manager node (High Availability).', 'nsxtSpec.nsxtManagers[].hostname', { show: isHA }),
          fqdnField('nsxC', 'Appliance 3 FQDN', 'sfo-m01-nsx01c.sfo.rainpole.io', 'Third NSX Manager node (High Availability).', 'nsxtSpec.nsxtManagers[].hostname', { show: isHA }),
          pwField('nsxAdminPw', 'Admin password', C.pw.nsx, 'NSX admin user password. At least 12 characters, no character repeated 3 times in a row.', 'nsxtSpec.nsxtAdminPassword'),
          pwField('nsxRootPw', 'Root password', C.pw.nsx, 'NSX Manager root password.', 'nsxtSpec.rootNsxtManagerPassword'),
          pwField('nsxAuditPw', 'Audit password', C.pw.nsx, 'NSX audit user password.', 'nsxtSpec.nsxtAuditPassword'),
          { id: 'nsxMode', label: 'NSX host switch operational mode', type: 'select', options: C.nsxMode, def: 'default', help: 'Datapath mode of the NSX-enabled distributed switch.', api: 'dvsSpecs[].nsxtSwitchConfig.hostSwitchOperationalMode' },
          { id: 'nsxTeam', label: 'NSX uplink teaming', type: 'select', options: C.nsxTeaming, def: 'LOADBALANCE_SRCID', show: fullStack, help: 'Teaming policy of the NSX uplink profile for TEP traffic. A LAG always uses failover order.', api: 'dvsSpecs[].nsxTeamings[].policy' },
          { id: 'overlayTz', label: 'Overlay transport zone name', type: 'text', show: fullStack, auto: (s, g) => g('nsxVip') ? 'overlay-tz-' + shortOf(g('nsxVip')) : '', help: 'Name of the NSX overlay transport zone.', api: 'dvsSpecs[].nsxtSwitchConfig.transportZones[].name' },
        ],
      },
      {
        id: 'vds', title: 'Distributed switches',
        intro: 'Switch layout of the management cluster. Profiles match the VCF Installer UI.',
        fields: [
          { id: 'vdsProfile', label: 'Switch profile', type: 'select', options: C.vdsProfile, def: 'default', rerender: true, help: 'Pre-configured switch layouts from the VCF Installer.' },
          { id: 'vdsCount', label: 'Number of switches', type: 'select', show: custom, def: '1', rerender: true, options: [{ v: '1', l: '1' }, { v: '2', l: '2' }, { v: '3', l: '3' }], help: 'Number of distributed switches in the custom layout.' },
          ...TRAFFIC.map(t => ({ id: 'vdsFor_' + t.k, label: t.label + ' on switch', type: 'select', def: '1', show: s => custom(s) && t.show(s) && Number(s.vdsCount) > 1, options: [{ v: '1', l: 'Switch 1' }, { v: '2', l: 'Switch 2' }, { v: '3', l: 'Switch 3' }], help: 'Distributed switch that carries ' + t.label + ' traffic.' })),
          { id: 'vdsFor_nsx', label: 'NSX overlay on switch', type: 'select', def: '1', show: s => custom(s) && Number(s.vdsCount) > 1, options: [{ v: '1', l: 'Switch 1' }, { v: '2', l: 'Switch 2' }, { v: '3', l: 'Switch 3' }], help: 'Distributed switch prepared for NSX.' },
          { type: 'note', kind: 'info', text: s => layoutText(s) },
          ...C.vdsFields(1, 'vmnic0,vmnic1', vdsCount, vdsNameAuto(1)),
          ...C.vdsFields(2, 'vmnic2,vmnic3', vdsCount, vdsNameAuto(2)),
          ...C.vdsFields(3, 'vmnic4,vmnic5', vdsCount, vdsNameAuto(3)),
          { id: 'pgAdvanced', label: 'Customize port group names and teaming', type: 'checkbox', def: false, rerender: true, help: 'When off, port groups get generated names, "Route based on physical NIC load" and all uplinks active (same defaults as the VCF Installer).' },
          ...trafficFields(),
        ],
      },
      {
        id: 'ops', title: 'VCF Operations',
        fields: [
          fqdnField('opsA', 'Primary node FQDN', 'flt-ops01a.rainpole.io', 'VCF Operations primary (master) node.', 'vcfOperationsSpec.nodes[].hostname'),
          fqdnField('opsB', 'Replica node FQDN', 'flt-ops01b.rainpole.io', 'VCF Operations replica node (High Availability).', 'vcfOperationsSpec.nodes[].hostname', { show: isHA }),
          fqdnField('opsC', 'Data node FQDN', 'flt-ops01c.rainpole.io', 'VCF Operations data node (High Availability).', 'vcfOperationsSpec.nodes[].hostname', { show: isHA }),
          fqdnField('opsLb', 'Load balancer FQDN', 'flt-ops01.rainpole.io', 'Virtual FQDN in front of the VCF Operations cluster (High Availability).', 'vcfOperationsSpec.loadBalancerFqdn', { show: isHA }),
          pwField('opsAdminPw', 'Administrator password', C.pw.fifteen, 'VCF Operations admin password. Minimum 15 characters.', 'vcfOperationsSpec.adminUserPassword'),
          pwField('opsRootPw', 'Node root password', C.pw.fifteen, 'Root password applied to all VCF Operations nodes.', 'vcfOperationsSpec.nodes[].rootUserPassword'),
          fqdnField('collectorFqdn', 'Collector (cloud proxy) FQDN', 'sfo-cp01.sfo.rainpole.io', 'VCF Operations collector for this instance.', 'vcfOperationsCollectorSpec.hostname'),
          pwField('collectorPw', 'Collector root password', C.pw.fifteen, 'Root password of the collector appliance.', 'vcfOperationsCollectorSpec.rootUserPassword'),
          fqdnField('licenseFqdn', 'License server FQDN', 'flt-lc01.rainpole.io', 'FQDN of the VCF license server component.', 'licenseServerSpec.hostname'),
        ],
      },
      {
        id: 'vsp', title: 'VCF management services',
        intro: 'Services runtime that hosts fleet-level and instance-level management services. IP range is set in the Networks section.',
        fields: [
          fqdnField('fleetFqdn', 'Fleet components FQDN', 'flt-fc01.rainpole.io', 'FQDN to access hosted fleet-level components that do not need their own FQDN (for example fleet lifecycle).', 'vspClusterSpec.fleetFqdn'),
          fqdnField('instanceFqdn', 'Instance components FQDN', 'sfo-ic01.sfo.rainpole.io', 'FQDN to access instance-level components (SDDC lifecycle, real-time metrics).', 'vspClusterSpec.instanceFqdn'),
          fqdnField('idbFqdn', 'Identity broker FQDN', 'flt-idb01.rainpole.io', 'FQDN of the VCF Identity Broker.', 'vidbSpec.hostname'),
          fqdnField('platformFqdn', 'VCF services runtime FQDN', 'sfo-sr01.sfo.rainpole.io', 'FQDN of the services runtime; the short name is used as prefix for its node VMs. Short name max 63 characters.', 'vspClusterSpec.platformFqdn'),
          pwField('vspPw', 'System user password (vmware-system-user)', C.pw.fifteen, 'SSH password for vmware-system-user on the runtime nodes. Minimum 15 characters.', 'vspClusterSpec.systemUserPassword'),
          { id: 'vspCidr', label: 'Internal cluster CIDR (IPv4)', type: 'select', options: C.internalCidr, def: '198.18.0.0/15', help: 'Pod network of the internal Kubernetes cluster. Must not be used anywhere else in your network.', api: 'vspClusterSpec.internalClusterCidrIpv4' },
        ],
      },
      {
        id: 'auto', title: 'VCF Automation', show: s => s.includeAuto,
        intro: 'VCF Automation IP range is set in the Networks section.',
        fields: [
          fqdnField('autoFqdn', 'VCF Automation FQDN', 'flt-auto01.rainpole.io', 'FQDN users use to access VCF Automation.', 'vcfAutomationSpec.hostname'),
          fqdnField('autoPlatformFqdn', 'VCF services runtime FQDN (Automation)', 'flt-vcfa-sr01.rainpole.io', 'Dedicated services runtime FQDN for VCF Automation (not the same as the management services runtime).', 'vcfAutomationSpec.platformFqdn'),
          pwField('autoAdminPw', 'Administrator password', C.pw.fifteen, 'VCF Automation admin password. Minimum 15 characters.', 'vcfAutomationSpec.adminUserPassword'),
          { id: 'autoCidr', label: 'Internal cluster CIDR (IPv4)', type: 'select', options: C.internalCidr, def: '198.18.0.0/15', help: 'Pod network of the VCF Automation Kubernetes cluster. Must be unused in your environment.', api: 'vcfAutomationSpec.internalClusterCidr' },
          { id: 'autoPrefix', label: 'Node prefix', type: 'text', req: true, ph: 'flt-auto', pattern: '^[a-z0-9][a-z0-9-]*[a-z0-9]$', patternMsg: 'Lowercase letters, digits and hyphens; must start and end with a letter or digit', maxLen: 57, help: 'Prefix for VCF Automation node VM names.', api: 'vcfAutomationSpec.nodePrefix' },
        ],
      },
      {
        id: 'sddcm', title: 'SDDC Manager',
        fields: [
          fqdnField('sddcFqdn', 'Appliance FQDN', 'sfo-vcf01.sfo.rainpole.io', 'FQDN of SDDC Manager. If the VCF Installer runs on a management host it is converted into SDDC Manager; otherwise a new appliance is deployed.', 'sddcManagerSpec.hostname', { maxLen: 63 }),
          pwField('sddcRootPw', 'Root password', C.pw.sddcRoot, 'SDDC Manager root password. Minimum 15 characters, special characters from !%@$^#?*.', 'sddcManagerSpec.rootPassword'),
          pwField('sddcVcfPw', 'vcf user password', C.pw.sddcRoot, 'Password of the vcf (SSH) user. Minimum 15 characters, special characters from !%@$^#?*.', 'sddcManagerSpec.sshPassword'),
          pwField('sddcLocalPw', 'Local admin password (admin@local)', C.pw.sddcLocal, 'Break-glass local administrator. Minimum 12 characters, special characters from !%@$^#?*.', 'sddcManagerSpec.localUserPassword'),
        ],
      },
    ],
  };

  function layoutText(s) {
    const n = vdsCount(s);
    const rows = [];
    for (let i = 1; i <= n; i++) {
      const items = TRAFFIC.filter(t => t.show(s) && vdsOf(s, t.k) === i).map(t => t.label);
      if (vdsOf(s, 'nsx') === i && fullStack(s)) items.push('NSX overlay');
      rows.push('<b>Switch ' + i + ':</b> ' + (items.join(', ') || '<i>nothing assigned</i>'));
    }
    return rows.join('<br>');
  }

  function pasteHosts(s, changed) {
    const text = prompt('Paste host FQDNs (one per line or comma separated):');
    if (!text) return;
    const names = C.list(text);
    if (!names.length) return;
    s.hosts = names.map((fqdn, i) => Object.assign({ fqdn: '', ssl: '' }, s.hosts[i] || {}, { fqdn }));
    changed(true);
  }

  // ---------- rules ----------
  form.rules = function (s, g) {
    const out = [];
    const hosts = s.hosts.map(h => (h.fqdn || '').trim()).filter(Boolean);

    if (isVsan(s) && hosts.length < 3) out.push({ level: 'error', field: 'hosts', msg: 'vSAN needs at least 3 hosts (4 recommended for maintenance headroom)' });
    if (s.storage === 'vsan-osa' && s.ftt === '2' && hosts.length < 5) out.push({ level: 'error', field: 'hosts', msg: 'vSAN OSA with FTT=2 needs at least 5 hosts' });
    if (!isVsan(s) && hosts.length < 2) out.push({ level: 'error', field: 'hosts', msg: 'At least 2 hosts are required' });

    // Unique FQDNs across hosts and appliances
    const seen = {};
    const fq = [];
    s.hosts.forEach((h, i) => fq.push(['hosts.' + i + '.fqdn', h.fqdn]));
    for (const id of ['vcFqdn', 'nsxVip', 'nsxA', 'nsxB', 'nsxC', 'opsA', 'opsB', 'opsC', 'opsLb', 'collectorFqdn', 'licenseFqdn', 'fleetFqdn', 'instanceFqdn', 'idbFqdn', 'platformFqdn', 'autoFqdn', 'autoPlatformFqdn', 'sddcFqdn']) {
      const f = findField(id);
      if (f && (!f.show || f.show(s, g)) && (id.indexOf('auto') !== 0 || s.includeAuto)) fq.push([id, s[id]]);
    }
    for (const [id, v] of fq) {
      const k = String(v || '').trim().toLowerCase();
      if (!k) continue;
      if (seen[k]) out.push({ level: 'error', field: id, msg: 'Duplicate FQDN ' + k + ' (also used by ' + seen[k] + ')' });
      else seen[k] = id;
    }

    // DNS / NTP
    if (s.dns1 && s.dns2 && s.dns1.trim() === s.dns2.trim()) out.push({ level: 'warn', field: 'dns2', msg: 'DNS server 2 is the same as DNS server 1' });

    // Networks
    const nets = [['mgmt', 'ESX management', true]];
    if (sepVmMgmt(s)) nets.push(['vmMgmt', 'VM management', true]);
    if (sepVcfMgmt(s)) nets.push(['vcfMgmt', 'VCF management', true]);
    nets.push(['vmotion', 'vMotion', true]);
    if (isVsan(s)) nets.push(['vsan', 'vSAN', true]);
    if (s.storage === 'nfs') nets.push(['nfs', 'NFS', true]);
    if (fullStack(s) && s.tepMode === 'pool') nets.push(['tep', 'Host overlay', true]);
    if (fullStack(s) && s.vpcConn === 'distributed') nets.push(['dtgw', 'DTGW', true]);

    for (let i = 0; i < nets.length; i++) {
      for (let j = i + 1; j < nets.length; j++) {
        const [a, la] = nets[i], [b, lb] = nets[j];
        const ga = s[a + 'Gw'], gb = s[b + 'Gw'];
        if (N.isCidr(ga) && N.isCidr(gb) && N.cidrsOverlap(ga, gb)) out.push({ level: 'error', field: b + 'Gw', msg: lb + ' subnet overlaps the ' + la + ' subnet' });
        const va = a === 'tep' ? s.tepVlan : s[a + 'Vlan'], vb = b === 'tep' ? s.tepVlan : s[b + 'Vlan'];
        if (va && vb && va.trim() === vb.trim() && va.trim() !== '0') out.push({ level: 'warn', field: (b === 'tep' ? 'tepVlan' : b + 'Vlan'), msg: lb + ' uses the same VLAN ' + vb + ' as ' + la });
      }
    }

    const needHostIps = hosts.length;
    C.rangeRules(out, { label: 'vMotion', gw: s.vmotionGw, start: s.vmotionStart, end: s.vmotionEnd, fieldStart: 'vmotionStart', fieldEnd: 'vmotionEnd', need: needHostIps, needMsg: 'needs one per host (' + needHostIps + ')' });
    if (isVsan(s)) C.rangeRules(out, { label: 'vSAN', gw: s.vsanGw, start: s.vsanStart, end: s.vsanEnd, fieldStart: 'vsanStart', fieldEnd: 'vsanEnd', need: needHostIps, needMsg: 'needs one per host (' + needHostIps + ')' });
    if (s.storage === 'nfs') C.rangeRules(out, { label: 'NFS', gw: s.nfsGw, start: s.nfsStart, end: s.nfsEnd, fieldStart: 'nfsStart', fieldEnd: 'nfsEnd', need: needHostIps, needMsg: 'needs one per host (' + needHostIps + ')' });
    if (fullStack(s) && s.tepMode === 'pool') {
      const nsxUplinks = C.list(s['vds' + vdsOf(s, 'nsx') + 'Nics']).length || 2;
      const need = s['vds' + vdsOf(s, 'nsx') + 'Type'] === 'lag' ? hosts.length : hosts.length * nsxUplinks;
      C.rangeRules(out, { label: 'Host overlay TEP pool', gw: s.tepGw, start: s.tepStart, end: s.tepEnd, fieldStart: 'tepStart', fieldEnd: 'tepEnd', need, needMsg: 'needs ' + need + ' (one per host uplink)' });
    }

    const cgw = componentGw(s);
    const vspN = C.rangeRules(out, { label: 'VCF management services range', gw: cgw, start: s.vspStart, end: s.vspEnd, fieldStart: 'vspStart', fieldEnd: 'vspEnd', need: 12, needMsg: 'minimum is 12' });
    if (vspN && vspN < 30) out.push({ level: 'info', field: 'vspEnd', msg: 'VCF management services range has ' + vspN + ' addresses; 30 are recommended to allow more components and auto-scaling' });
    if (s.includeAuto) {
      const need = isHA(s) ? 5 : 2;
      C.rangeRules(out, { label: 'VCF Automation range', gw: cgw, start: s.autoStart, end: s.autoEnd, fieldStart: 'autoStart', fieldEnd: 'autoEnd', need, needMsg: 'needs ' + need + ' for the ' + (isHA(s) ? 'High Availability' : 'Simple') + ' model' });
      if ([s.vspStart, s.vspEnd, s.autoStart, s.autoEnd].every(N.isIPv4) && N.rangesOverlap(s.vspStart, s.vspEnd, s.autoStart, s.autoEnd)) {
        out.push({ level: 'error', field: 'autoStart', msg: 'VCF Automation range overlaps the VCF management services range' });
      }
      if (isHA(s) && s.autoSize === 'small') out.push({ level: 'warn', field: 'autoSize', msg: 'VCF Automation does not support High Availability with size small; it will be deployed in Simple mode' });
    }

    // Ranges inside other subnets must not collide with gateway of mgmt
    if (fullStack(s) && s.tepMode === 'pool' && N.isCidr(s.tepGw) && N.isCidr(s.mgmtGw) && N.cidrsOverlap(s.tepGw, s.mgmtGw)) {
      out.push({ level: 'error', field: 'tepGw', msg: 'Host overlay subnet must be different from ESX management' });
    }

    // MTU vs switch MTU
    for (const t of TRAFFIC) {
      if (!t.show(s)) continue;
      const netKey = { mgmt: 'mgmt', vmmgmt: sepVmMgmt(s) ? 'vmMgmt' : 'mgmt', vcfmgmt: 'vcfMgmt', vmotion: 'vmotion', vsan: 'vsan', nfs: 'nfs' }[t.k];
      const mtu = Number(s[netKey + 'Mtu']);
      const i = vdsOf(s, t.k);
      const vmtu = Number(s['vds' + i + 'Mtu']);
      if (mtu && vmtu && mtu > vmtu) out.push({ level: 'error', field: netKey + 'Mtu', msg: t.label + ' MTU ' + mtu + ' is larger than switch ' + i + ' MTU ' + vmtu });
    }
    if (fullStack(s)) {
      const i = vdsOf(s, 'nsx');
      const vmtu = Number(s['vds' + i + 'Mtu']);
      if (vmtu && vmtu < 1600) out.push({ level: 'error', field: 'vds' + i + 'Mtu', msg: 'Switch ' + i + ' carries NSX overlay and needs MTU 1600 or higher (1700+ recommended)' });
    }

    // Switches: NIC usage
    const nicsUsed = {};
    for (let i = 1; i <= vdsCount(s); i++) {
      const nics = C.list(s['vds' + i + 'Nics']);
      if (nics.length < 2) out.push({ level: 'warn', field: 'vds' + i + 'Nics', msg: 'Switch ' + i + ' has fewer than 2 NICs; VCF requires 2 uplinks for redundancy' });
      for (const n of nics) {
        if (nicsUsed[n]) out.push({ level: 'error', field: 'vds' + i + 'Nics', msg: n + ' is assigned to switch ' + nicsUsed[n] + ' and switch ' + i });
        nicsUsed[n] = i;
      }
      const used = TRAFFIC.some(t => t.show(s) && vdsOf(s, t.k) === i) || (fullStack(s) && vdsOf(s, 'nsx') === i);
      if (!used) out.push({ level: 'warn', field: 'vds' + i + 'Nics', msg: 'Switch ' + i + ' has no traffic assigned' });
    }
    if (custom(s) && vdsOf(s, 'mgmt') !== 1) out.push({ level: 'warn', field: 'vdsFor_mgmt', msg: 'ESX management is normally on switch 1 (the switch that holds vmk0 after migration)' });

    if (s.storage === 'nfs' && s.nfsServer && N.isIPv4(s.nfsServer) && N.isCidr(s.nfsGw) && !N.inSubnet(s.nfsServer, s.nfsGw)) {
      out.push({ level: 'info', field: 'nfsServer', msg: 'NFS server is not in the NFS VMkernel subnet; traffic will be routed' });
    }
    if (!s.skipThumb && s.hosts.some(h => !(h.ssl || '').trim())) {
      out.push({ level: 'info', field: 'hosts', msg: 'Some hosts have no SSL thumbprint; the VCF Installer will ask you to confirm the fingerprints' });
    }
    if (s.autoPw) out.push({ level: 'info', msg: 'Passwords are auto-generated by the installer and are not included in the JSON' });
    if (s.vspCidr && s.includeAuto && s.autoCidr === s.vspCidr) out.push({ level: 'info', field: 'autoCidr', msg: 'VCF Automation and management services use the same internal cluster CIDR (allowed: the clusters are isolated)' });
    return out;
  };

  function findField(id) {
    for (const sec of form.sections) for (const f of sec.fields) if (f.id === id) return f;
    return null;
  }

  // ---------- JSON builder ----------
  function netSpec(s, g, type, key, k, range) {
    const c = N.parseCidr(s[key + 'Gw']);
    const i = vdsOf(s, k);
    const lag = s['vds' + i + 'Type'] === 'lag';
    const ns = {
      networkType: type,
      subnet: c ? c.cidr : '',
      gateway: c ? c.ip : '',
      vlanId: C.int(s[key + 'Vlan']),
      mtu: C.int(s[key + 'Mtu']),
      portGroupKey: g('pg_' + k),
    };
    if (range) ns.includeIpAddressRanges = [{ startIpAddress: s[key + 'Start'], endIpAddress: s[key + 'End'] }];
    if (lag) {
      ns.teamingPolicy = 'failover_explicit';
      ns.activeUplinks = [g('vds' + i + 'LagName')];
      ns.standbyUplinks = [];
    } else if (s.pgAdvanced) {
      ns.teamingPolicy = s['team_' + k];
      ns.activeUplinks = C.list(g('act_' + k));
      ns.standbyUplinks = C.list(s['stby_' + k]);
    } else {
      ns.teamingPolicy = 'loadbalance_loadbased';
      ns.activeUplinks = uplinkNames(s, g, i);
      ns.standbyUplinks = [];
    }
    return ns;
  }

  form.build = function (s, g) {
    const ha = isHA(s);
    const withPw = !s.autoPw;
    const j = {
      sddcId: g('sddcId'),
      vcfInstanceName: g('vcfInstanceName'),
      workflowType: 'VCF',
      version: g('version'),
      ceipEnabled: !!s.ceip,
      skipEsxThumbprintValidation: !!s.skipThumb,
      skipGatewayPingValidation: !!s.skipGwPing,
      managementPoolName: g('poolName'),
      dnsSpec: { subdomain: g('dnsDomain'), nameservers: [g('dns1'), g('dns2')].filter(Boolean) },
      ntpServers: [g('ntp1'), g('ntp2')].filter(Boolean),
    };

    j.vcenterSpec = { vcenterHostname: g('vcFqdn'), vmSize: s.vcSize, storageSize: s.vcStorage, ssoDomain: g('ssoDomain'), useExistingDeployment: false, rootVcenterPassword: s.vcRootPw };
    if (withPw) j.vcenterSpec.adminUserSsoPassword = s.ssoPw;

    j.clusterSpec = { datacenterName: g('datacenter'), clusterName: g('clusterName') };
    if (s.evc) j.clusterSpec.clusterEvcMode = s.evc;

    // Storage
    if (isVsan(s)) {
      const vsan = { datastoreName: g('datastoreName'), esaConfig: { enabled: s.storage === 'vsan-esa' } };
      if (s.storage === 'vsan-esa' && s.esaAutoClaim) vsan.esaConfig.skipHclAutoDiskClaim = true;
      if (s.storage === 'vsan-osa') {
        vsan.vsanDedup = !!s.dedup;
        vsan.failuresToTolerate = Number(s.ftt);
      }
      vsan.encryptionConfig = { dataInTransitConfig: { enable: !!s.dit } };
      if (s.dit) vsan.encryptionConfig.dataInTransitConfig.rekeyInterval = Number(s.rekey === 'custom' ? s.rekeyCustom : s.rekey);
      j.datastoreSpec = { vsanSpec: vsan };
    } else if (s.storage === 'nfs') {
      j.datastoreSpec = { nfsDatastoreSpec: { datastoreName: g('datastoreName'), nasVolume: { serverName: [g('nfsServer')], path: g('nfsPath'), readOnly: false, enableBindToVmknic: !!s.nfsBind } } };
    } else {
      j.datastoreSpec = { vmfsDatastoreSpec: { fcSpec: [{ datastoreName: g('datastoreName') }] } };
    }

    // NSX
    const nsx = {
      nsxtManagerSize: s.nsxSize,
      nsxtManagers: [{ hostname: g('nsxA') }].concat(ha ? [{ hostname: g('nsxB') }, { hostname: g('nsxC') }] : []),
      vipFqdn: g('nsxVip'),
      useExistingDeployment: false,
      skipNsxOverlayOverManagementNetwork: true,
    };
    if (withPw) Object.assign(nsx, { nsxtAdminPassword: s.nsxAdminPw, nsxtAuditPassword: s.nsxAuditPw, rootNsxtManagerPassword: s.nsxRootPw });
    if (fullStack(s)) {
      nsx.transportVlanId = C.int(s.tepVlan);
      if (s.tepMode === 'pool') {
        const c = N.parseCidr(s.tepGw);
        nsx.ipAddressPoolSpec = {
          name: g('tepPoolName'),
          description: 'ESX host overlay TEP IP pool',
          subnets: [{ cidr: c ? c.cidr : '', gateway: c ? c.ip : '', ipAddressPoolRanges: [{ start: s.tepStart, end: s.tepEnd }] }],
        };
      }
      if (s.vpcConn === 'distributed') {
        const dt = { vlan: C.int(s.dtgwVlan), gatewayCidr: g('dtgwGw'), externalIpBlockCidr: g('dtgwExt') };
        if (g('dtgwPriv')) dt.privateTgwIpBlockCidr = g('dtgwPriv');
        nsx.vpcSpec = { vpcNetworkConfigurationType: 'FULL_STACK_VPC', dtgwSpec: dt };
      }
    } else {
      nsx.vpcSpec = { vpcNetworkConfigurationType: 'VLAN_BACKED_VPC' };
      nsx.overlayVtepSpec = { vtepType: 'NO_IP' };
    }
    j.nsxtSpec = nsx;

    // VCF Operations
    const node = (h, type) => {
      const n = { hostname: g(h), type };
      if (withPw) n.rootUserPassword = s.opsRootPw;
      return n;
    };
    j.vcfOperationsSpec = { nodes: [node('opsA', 'master')].concat(ha ? [node('opsB', 'replica'), node('opsC', 'data')] : []), applianceSize: s.opsSize, useExistingDeployment: false };
    if (withPw) j.vcfOperationsSpec.adminUserPassword = s.opsAdminPw;
    if (ha) j.vcfOperationsSpec.loadBalancerFqdn = g('opsLb');

    j.vcfOperationsCollectorSpec = { hostname: g('collectorFqdn'), applianceSize: s.collectorSize, useExistingDeployment: false };
    if (withPw) j.vcfOperationsCollectorSpec.rootUserPassword = s.collectorPw;

    if (s.includeAuto) {
      const a = { hostname: g('autoFqdn'), platformFqdn: g('autoPlatformFqdn'), nodePrefix: g('autoPrefix'), useExistingDeployment: false, ipPool: N.expandRange(s.autoStart, s.autoEnd, 64), internalClusterCidr: s.autoCidr, size: s.autoSize };
      if (withPw) a.adminUserPassword = s.autoAdminPw;
      j.vcfAutomationSpec = a;
    }

    j.vspClusterSpec = {
      platformFqdn: g('platformFqdn'),
      instanceFqdn: g('instanceFqdn'),
      fleetFqdn: g('fleetFqdn'),
      size: s.vspSize === 'auto' ? (ha ? 'medium' : 'small') : s.vspSize,
      internalClusterCidrIpv4: s.vspCidr,
      ipv4Pool: { ipRange: { startIpAddress: s.vspStart, endIpAddress: s.vspEnd } },
    };
    if (withPw) j.vspClusterSpec.systemUserPassword = s.vspPw;
    j.vidbSpec = { hostname: g('idbFqdn') };
    j.licenseServerSpec = { hostname: g('licenseFqdn') };
    j.sddcLcmSpec = {};
    j.saltSpec = {};
    j.saltRaasSpec = {};
    j.telemetryAcceptorSpec = {};
    j.fleetDepotSpec = {};

    // Hosts
    j.hostSpecs = s.hosts.filter(h => (h.fqdn || '').trim()).map(h => {
      const o = { hostname: h.fqdn.trim(), credentials: { username: 'root', password: s.esxPw } };
      if (!s.skipThumb && (h.ssl || '').trim()) o.sslThumbprint = h.ssl.trim();
      return o;
    });

    // Networks
    const nets = [netSpec(s, g, 'MANAGEMENT', 'mgmt', 'mgmt')];
    nets.push(netSpec(s, g, 'VM_MANAGEMENT', sepVmMgmt(s) ? 'vmMgmt' : 'mgmt', 'vmmgmt'));
    if (sepVcfMgmt(s)) nets.push(netSpec(s, g, 'FLEET_MANAGEMENT', 'vcfMgmt', 'vcfmgmt'));
    nets.push(netSpec(s, g, 'VMOTION', 'vmotion', 'vmotion', true));
    if (isVsan(s)) nets.push(netSpec(s, g, 'VSAN', 'vsan', 'vsan', true));
    if (s.storage === 'nfs') nets.push(netSpec(s, g, 'NFS', 'nfs', 'nfs', true));
    j.networkSpecs = nets;

    // Switches
    const dvs = [];
    const modeVal = s.nsxMode === 'default' ? 'ENS_INTERRUPT' : s.nsxMode;
    for (let i = 1; i <= vdsCount(s); i++) {
      const nics = C.list(s['vds' + i + 'Nics']);
      const lag = s['vds' + i + 'Type'] === 'lag';
      const lagName = g('vds' + i + 'LagName');
      const d = {
        dvsName: g('vds' + i + 'Name'),
        networks: TRAFFIC.filter(t => t.show(s) && vdsOf(s, t.k) === i).map(t => t.type),
        mtu: C.int(s['vds' + i + 'Mtu']),
        vmnicsToUplinks: nics.map((id, n) => ({ id, uplink: lag ? lagName + '-' + n : 'uplink' + (n + 1) })),
      };
      if (vdsOf(s, 'nsx') === i) {
        d.nsxtSwitchConfig = { transportZones: fullStack(s) ? [{ name: g('overlayTz'), transportType: 'OVERLAY' }] : [{ name: 'nsx-vlan-transportzone-0', transportType: 'VLAN' }], hostSwitchOperationalMode: modeVal };
        if (fullStack(s)) {
          d.nsxTeamings = [lag
            ? { policy: 'FAILOVER_ORDER', activeUplinks: [lagName], standByUplinks: [] }
            : { policy: s.nsxTeam, activeUplinks: s.nsxTeam === 'FAILOVER_ORDER' ? ['uplink1'] : nics.map((_, n) => 'uplink' + (n + 1)), standByUplinks: s.nsxTeam === 'FAILOVER_ORDER' ? nics.slice(1).map((_, n) => 'uplink' + (n + 2)) : [] }];
        }
      }
      if (lag) {
        d.lagSpecs = [{ name: lagName, uplinksCount: nics.length, lacpMode: s['vds' + i + 'LacpMode'], loadBalancingMode: s['vds' + i + 'LagLb'], lacpTimeoutMode: s['vds' + i + 'LacpTimeout'] }];
      }
      dvs.push(d);
    }
    j.dvsSpecs = dvs;

    j.sddcManagerSpec = { hostname: g('sddcFqdn'), useExistingDeployment: false };
    if (withPw) Object.assign(j.sddcManagerSpec, { rootPassword: s.sddcRootPw, sshPassword: s.sddcVcfPw, localUserPassword: s.sddcLocalPw });

    const name = (g('sddcId') || 'management-domain') + '-vcf-installer.json';
    return [{
      name, title: 'VCF Installer spec', main: true, json: j,
      method: 'POST', endpoint: '/v1/sddcs  (validate first: POST /v1/sddcs/validations)',
      note: 'Upload in the VCF Installer UI (Deploy a new VCF fleet &gt; JSON) or post to the installer API.',
      schema: { api: 'vcf-installer-api', type: 'SddcSpec' },
    }];
  };

  // ---------- import ----------
  form.detect = j => j && !Array.isArray(j) && (j.sddcId !== undefined || j.vcenterSpec && j.vcenterSpec.vcenterHostname !== undefined) && !j.computeSpec;
  form.rawSchema = () => ({ api: 'vcf-installer-api', type: 'SddcSpec' });

  const KNOWN = ['sddcId', 'vcfInstanceName', 'workflowType', 'version', 'ceipEnabled', 'skipEsxThumbprintValidation', 'skipGatewayPingValidation', 'managementPoolName', 'dnsSpec', 'ntpServers', 'vcenterSpec', 'clusterSpec', 'datastoreSpec', 'nsxtSpec', 'vcfOperationsSpec', 'vcfOperationsCollectorSpec', 'vcfAutomationSpec', 'vspClusterSpec', 'vidbSpec', 'licenseServerSpec', 'sddcLcmSpec', 'saltSpec', 'saltRaasSpec', 'telemetryAcceptorSpec', 'fleetDepotSpec', 'fleetLcmSpec', 'hostSpecs', 'networkSpecs', 'dvsSpecs', 'sddcManagerSpec'];

  form.fromJson = function (j) {
    const s = {};
    const notes = [];
    const str = v => (v === undefined || v === null ? '' : String(v));
    const gwc = (gw, subnet) => {
      if (!gw) return '';
      const p = subnet && subnet.indexOf('/') > 0 ? subnet.split('/')[1] : '24';
      return gw + '/' + p;
    };
    s.vcfInstanceName = str(j.vcfInstanceName);
    s.sddcId = str(j.sddcId);
    s.version = str(j.version);
    s.ceip = j.ceipEnabled !== false && j.ceipEnabled !== 'false';
    s.skipThumb = !!j.skipEsxThumbprintValidation;
    s.skipGwPing = !!j.skipGatewayPingValidation;
    s.poolName = str(j.managementPoolName);
    if (j.workflowType && j.workflowType !== 'VCF') notes.push('workflowType ' + j.workflowType + ' is imported as VCF (new fleet). Only greenfield deployments are supported by this form.');

    const dns = j.dnsSpec || {};
    s.dnsDomain = str(dns.subdomain);
    const ns = dns.nameservers || (dns.nameserver ? [dns.nameserver] : []);
    s.dns1 = str(ns[0]); s.dns2 = str(ns[1]);
    const ntp = j.ntpServers || [];
    s.ntp1 = str(ntp[0]); s.ntp2 = str(ntp[1]);

    const vc = j.vcenterSpec || {};
    s.vcFqdn = str(vc.vcenterHostname);
    if (vc.vmSize) s.vcSize = String(vc.vmSize).toLowerCase();
    s.vcStorage = str(vc.storageSize).toLowerCase();
    s.ssoDomain = str(vc.ssoDomain) || 'vsphere.local';
    s.vcRootPw = str(vc.rootVcenterPassword);
    s.ssoPw = str(vc.adminUserSsoPassword);
    const cl = j.clusterSpec || {};
    s.datacenter = str(cl.datacenterName);
    s.clusterName = str(cl.clusterName);
    s.evc = str(cl.clusterEvcMode);

    const ds = j.datastoreSpec || {};
    if (ds.vsanSpec) {
      const v = ds.vsanSpec;
      const esa = v.esaConfig && (v.esaConfig.enabled === true || v.esaConfig.enabled === 'true');
      s.storage = esa ? 'vsan-esa' : 'vsan-osa';
      s.datastoreName = str(v.datastoreName);
      s.esaAutoClaim = !!(v.esaConfig && v.esaConfig.skipHclAutoDiskClaim);
      s.dedup = v.vsanDedup === true || v.vsanDedup === 'true';
      if (v.failuresToTolerate) s.ftt = String(v.failuresToTolerate) === '2' ? '2' : '1';
      const dit = v.encryptionConfig && v.encryptionConfig.dataInTransitConfig;
      s.dit = !!(dit && dit.enable);
      if (dit && dit.rekeyInterval) {
        const r = String(dit.rekeyInterval);
        if (C.rekey.some(o => o.v === r)) s.rekey = r;
        else { s.rekey = 'custom'; s.rekeyCustom = r; }
      }
    } else if (ds.nfsDatastoreSpec) {
      s.storage = 'nfs';
      const n = ds.nfsDatastoreSpec;
      s.datastoreName = str(n.datastoreName);
      const nv = n.nasVolume || {};
      s.nfsServer = str((nv.serverName || [])[0]);
      s.nfsPath = str(nv.path);
      s.nfsBind = nv.enableBindToVmknic !== false;
    } else if (ds.vmfsDatastoreSpec) {
      s.storage = 'fc';
      s.datastoreName = str(((ds.vmfsDatastoreSpec.fcSpec || [])[0] || {}).datastoreName);
    }

    const nsx = j.nsxtSpec || {};
    const mgrs = nsx.nsxtManagers || [];
    s.deployModel = mgrs.length >= 3 || ((j.vcfOperationsSpec || {}).nodes || []).length >= 3 ? 'ha' : 'simple';
    s.nsxVip = str(nsx.vipFqdn);
    s.nsxA = str((mgrs[0] || {}).hostname); s.nsxB = str((mgrs[1] || {}).hostname); s.nsxC = str((mgrs[2] || {}).hostname);
    if (nsx.nsxtManagerSize) s.nsxSize = String(nsx.nsxtManagerSize).toLowerCase();
    s.nsxAdminPw = str(nsx.nsxtAdminPassword); s.nsxRootPw = str(nsx.rootNsxtManagerPassword); s.nsxAuditPw = str(nsx.nsxtAuditPassword);
    s.tepVlan = str(nsx.transportVlanId);
    const vpc = nsx.vpcSpec || {};
    s.vpcType = (vpc.vpcNetworkConfigurationType === 'VLAN_BACKED_VPC' || (nsx.overlayVtepSpec && nsx.overlayVtepSpec.vtepType === 'NO_IP')) ? 'vlan' : 'full';
    if (vpc.dtgwSpec) {
      s.vpcConn = 'distributed';
      s.dtgwVlan = str(vpc.dtgwSpec.vlan); s.dtgwGw = str(vpc.dtgwSpec.gatewayCidr);
      s.dtgwExt = str(vpc.dtgwSpec.externalIpBlockCidr); s.dtgwPriv = str(vpc.dtgwSpec.privateTgwIpBlockCidr);
    } else s.vpcConn = 'centralized';
    const pool = nsx.ipAddressPoolSpec;
    if (pool && pool.subnets && pool.subnets[0]) {
      s.tepMode = 'pool';
      const sub = pool.subnets[0];
      s.tepPoolName = str(pool.name);
      s.tepGw = gwc(sub.gateway, sub.cidr);
      const r = (sub.ipAddressPoolRanges || [])[0] || {};
      s.tepStart = str(r.start); s.tepEnd = str(r.end);
    } else if (s.vpcType === 'full') s.tepMode = 'dhcp';

    const ops = j.vcfOperationsSpec || {};
    const nodes = ops.nodes || [];
    const byType = t => nodes.find(n => n.type === t) || {};
    s.opsA = str((byType('master').hostname ? byType('master') : nodes[0] || {}).hostname);
    s.opsB = str(byType('replica').hostname); s.opsC = str(byType('data').hostname);
    s.opsLb = str(ops.loadBalancerFqdn);
    if (ops.applianceSize) s.opsSize = String(ops.applianceSize).toLowerCase();
    s.opsAdminPw = str(ops.adminUserPassword);
    s.opsRootPw = str((nodes[0] || {}).rootUserPassword);
    const col = j.vcfOperationsCollectorSpec || {};
    s.collectorFqdn = str(col.hostname); s.collectorPw = str(col.rootUserPassword);
    if (col.applianceSize || col.applicationSize) s.collectorSize = String(col.applianceSize || col.applicationSize).toLowerCase();
    s.licenseFqdn = str((j.licenseServerSpec || {}).hostname);
    s.idbFqdn = str((j.vidbSpec || {}).hostname);

    const vsp = j.vspClusterSpec || {};
    s.fleetFqdn = str(vsp.fleetFqdn); s.instanceFqdn = str(vsp.instanceFqdn); s.platformFqdn = str(vsp.platformFqdn);
    s.vspPw = str(vsp.systemUserPassword);
    if (vsp.internalClusterCidrIpv4) s.vspCidr = vsp.internalClusterCidrIpv4;
    s.vspSize = vsp.size ? (vsp.size === (s.deployModel === 'ha' ? 'medium' : 'small') ? 'auto' : vsp.size) : 'auto';
    const vpool = vsp.ipv4Pool || {};
    if (vpool.ipRange) { s.vspStart = str(vpool.ipRange.startIpAddress); s.vspEnd = str(vpool.ipRange.endIpAddress); }
    else if (vpool.addresses && vpool.addresses.length) {
      s.vspStart = vpool.addresses[0]; s.vspEnd = vpool.addresses[vpool.addresses.length - 1];
      notes.push('VCF management services address list was converted to a range ' + s.vspStart + ' - ' + s.vspEnd + '. Check that the addresses were contiguous.');
    }

    const au = j.vcfAutomationSpec;
    s.includeAuto = !!au;
    if (au) {
      s.autoFqdn = str(au.hostname); s.autoPlatformFqdn = str(au.platformFqdn); s.autoAdminPw = str(au.adminUserPassword);
      s.autoPrefix = str(au.nodePrefix);
      if (au.internalClusterCidr) s.autoCidr = au.internalClusterCidr;
      if (au.size) s.autoSize = String(au.size).toLowerCase();
      const ip = au.ipPool || [];
      s.autoStart = str(ip[0]); s.autoEnd = str(ip[ip.length - 1]);
    }

    const sm = j.sddcManagerSpec || {};
    s.sddcFqdn = str(sm.hostname);
    s.sddcRootPw = str(sm.rootPassword || (sm.rootUserCredentials || {}).password);
    s.sddcVcfPw = str(sm.sshPassword || (sm.secondUserCredentials || {}).password);
    s.sddcLocalPw = str(sm.localUserPassword);

    let expanded = 0;
    for (const id of ['vcFqdn', 'nsxVip', 'nsxA', 'nsxB', 'nsxC', 'opsA', 'opsB', 'opsC', 'opsLb', 'collectorFqdn', 'licenseFqdn', 'idbFqdn', 'fleetFqdn', 'instanceFqdn', 'platformFqdn', 'autoFqdn', 'autoPlatformFqdn', 'sddcFqdn']) {
      if (s[id] && s[id].indexOf('.') < 0 && s.dnsDomain) { s[id] += '.' + s.dnsDomain; expanded++; }
    }
    if (expanded) notes.push(expanded + ' short host name(s) were expanded with the DNS domain ' + s.dnsDomain + '.');

    const hs = j.hostSpecs || [];
    s.hosts = hs.map(h => ({ fqdn: str(h.hostname).indexOf('.') < 0 && s.dnsDomain ? h.hostname + '.' + s.dnsDomain : str(h.hostname), ssl: str(h.sslThumbprint) }));
    s.esxPw = str(((hs[0] || {}).credentials || {}).password);

    s.autoPw = !(s.ssoPw || s.nsxAdminPw || s.sddcRootPw || s.opsAdminPw);

    // Networks
    const nets = j.networkSpecs || [];
    const byNet = t => nets.find(n => n.networkType === t);
    const mapNet = (n, key, range) => {
      if (!n) return;
      s[key + 'Vlan'] = str(n.vlanId);
      s[key + 'Mtu'] = str(n.mtu);
      s[key + 'Gw'] = gwc(n.gateway, n.subnet);
      if (range) {
        const r = (n.includeIpAddressRanges || [])[0] || {};
        s[key + 'Start'] = str(r.startIpAddress); s[key + 'End'] = str(r.endIpAddress);
      }
    };
    const mg = byNet('MANAGEMENT'), vm = byNet('VM_MANAGEMENT'), fl = byNet('FLEET_MANAGEMENT');
    mapNet(mg, 'mgmt');
    if (vm && mg && String(vm.vlanId) === String(mg.vlanId) && vm.gateway === mg.gateway) s.vmMgmtMode = 'esx';
    else if (vm) { s.vmMgmtMode = 'separate'; mapNet(vm, 'vmMgmt'); }
    if (fl) { s.vcfMgmtMode = 'separate'; mapNet(fl, 'vcfMgmt'); } else s.vcfMgmtMode = 'vm';
    mapNet(byNet('VMOTION'), 'vmotion', true);
    mapNet(byNet('VSAN'), 'vsan', true);
    mapNet(byNet('NFS'), 'nfs', true);

    // Switches
    const dvs = j.dvsSpecs || [];
    const where = t => dvs.findIndex(d => (d.networks || []).includes(t)) + 1;
    const nsxIdx = dvs.findIndex(d => d.nsxtSwitchConfig) + 1 || 1;
    const stIdx = where('VSAN') || where('NFS') || 1;
    const count = dvs.length || 1;
    let profile = 'custom';
    const allOn1 = ['MANAGEMENT', 'VMOTION'].every(t => where(t) <= 1);
    if (allOn1) {
      if (count === 1) profile = 'default';
      else if (count === 2 && stIdx === 2 && nsxIdx === 1) profile = 'storage';
      else if (count === 2 && stIdx === 1 && nsxIdx === 2) profile = 'nsx';
      else if (count === 3 && stIdx === 2 && nsxIdx === 3) profile = 'storage-nsx';
    }
    s.vdsProfile = profile;
    s.vdsCount = String(Math.min(count, 3));
    if (profile === 'custom') {
      for (const t of TRAFFIC) s['vdsFor_' + t.k] = String(where(t.type) || 1);
      s.vdsFor_nsx = String(nsxIdx);
    }
    if (dvs.length > 3) notes.push('Only the first 3 distributed switches were imported.');
    dvs.slice(0, 3).forEach((d, n) => {
      const i = n + 1;
      s['vds' + i + 'Name'] = str(d.dvsName);
      s['vds' + i + 'Mtu'] = str(d.mtu || 9000);
      const m = d.vmnicsToUplinks || (d.vmnics || []).map(id => ({ id }));
      s['vds' + i + 'Nics'] = m.map(x => x.id).join(',');
      const lag = (d.lagSpecs || [])[0];
      s['vds' + i + 'Type'] = lag ? 'lag' : 'uplinks';
      if (lag) {
        s['vds' + i + 'LagName'] = str(lag.name);
        s['vds' + i + 'LacpMode'] = str(lag.lacpMode).toUpperCase() || 'ACTIVE';
        s['vds' + i + 'LagLb'] = str(lag.loadBalancingMode);
        s['vds' + i + 'LacpTimeout'] = str(lag.lacpTimeoutMode).toUpperCase() || 'SLOW';
      }
      if (d.nsxtSwitchConfig) {
        const mode = d.nsxtSwitchConfig.hostSwitchOperationalMode;
        s.nsxMode = !mode || mode === 'ENS_INTERRUPT' ? 'default' : mode;
        const tz = (d.nsxtSwitchConfig.transportZones || []).find(z => z.transportType === 'OVERLAY');
        if (tz && tz.name) s.overlayTz = tz.name;
        const team = (d.nsxTeamings || [])[0];
        if (team && !lag) s.nsxTeam = team.policy;
      }
    });

    // Port groups / teaming
    let advanced = false;
    for (const t of TRAFFIC) {
      const n = byNet(t.type);
      if (!n) continue;
      s['pg_' + t.k] = str(n.portGroupKey);
      if (n.teamingPolicy) s['team_' + t.k] = n.teamingPolicy;
      s['act_' + t.k] = (n.activeUplinks || []).join(',');
      s['stby_' + t.k] = (n.standbyUplinks || []).join(',');
      const i = where(t.type) || 1;
      const isLag = dvs[i - 1] && (dvs[i - 1].lagSpecs || []).length;
      const defUplinks = C.list((s['vds' + i + 'Nics'] || '')).map((_, x) => 'uplink' + (x + 1)).join(',');
      if (!isLag && ((n.teamingPolicy && n.teamingPolicy !== 'loadbalance_loadbased') || (s['act_' + t.k] && s['act_' + t.k] !== defUplinks) || s['stby_' + t.k])) advanced = true;
    }
    s.pgAdvanced = advanced;

    const extra = {};
    for (const k of Object.keys(j)) if (!KNOWN.includes(k)) extra[k] = j[k];
    if (Object.keys(extra).length) notes.push('Fields not handled by the form are kept unchanged in the output: ' + Object.keys(extra).join(', '));
    return { state: s, extra, notes };
  };

  // ---------- workbook sample ----------
  form.sample = function () {
    const pwd = 'VMw@re1!VMw@re1!';
    const hosts = [];
    for (let i = 1; i <= 4; i++) hosts.push({ fqdn: 'sfo01-m01-r01-esx0' + i + '.sfo.rainpole.io', ssl: '' });
    return {
      vcfInstanceName: 'San Francisco', sddcId: 'sfo-m01', version: '9.1.1.0', ceip: true,
      deployModel: 'ha', opsSize: 'medium', collectorSize: 'standard', vcSize: 'medium', vcStorage: 'lstorage', nsxSize: 'medium', autoSize: 'medium',
      vmMgmtMode: 'separate', vcfMgmtMode: 'separate', vpcType: 'full', vpcConn: 'centralized',
      storage: 'vsan-esa', datastoreName: 'sfo-m01-cl01-ds-vsan01',
      dnsDomain: 'rainpole.io', dns1: '10.11.10.4', dns2: '10.11.10.5', ntp1: 'ntp0.sfo.rainpole.io', ntp2: 'ntp1.sfo.rainpole.io',
      esxPw: 'VMw@re1!', hosts,
      mgmtVlan: '1111', mgmtMtu: '1500', mgmtGw: '10.11.11.1/24',
      vmMgmtVlan: '1110', vmMgmtMtu: '1500', vmMgmtGw: '10.11.10.1/24',
      vcfMgmtVlan: '1199', vcfMgmtMtu: '1500', vcfMgmtGw: '10.11.99.1/24',
      vspStart: '10.11.99.31', vspEnd: '10.11.99.45', autoStart: '10.11.99.46', autoEnd: '10.11.99.50',
      vmotionVlan: '1112', vmotionMtu: '9000', vmotionGw: '10.11.12.1/24', vmotionStart: '10.11.12.101', vmotionEnd: '10.11.12.116',
      vsanVlan: '1113', vsanMtu: '9000', vsanGw: '10.11.13.1/24', vsanStart: '10.11.13.101', vsanEnd: '10.11.13.116',
      tepVlan: '1114', tepMode: 'pool', tepGw: '10.11.14.1/24', tepStart: '10.11.14.101', tepEnd: '10.11.14.132',
      poolName: 'sfo01-m01-r01-network-pool-01', tepPoolName: 'sfo01-m01-r01-ip-pool01-host',
      vcFqdn: 'sfo-m01-vc01.sfo.rainpole.io', datacenter: 'sfo-m01-dc01', clusterName: 'sfo-m01-cl01', ssoDomain: 'vsphere.local', vcRootPw: pwd, ssoPw: pwd,
      nsxVip: 'sfo-m01-nsx01.sfo.rainpole.io', nsxA: 'sfo-m01-nsx01a.sfo.rainpole.io', nsxB: 'sfo-m01-nsx01b.sfo.rainpole.io', nsxC: 'sfo-m01-nsx01c.sfo.rainpole.io',
      nsxAdminPw: pwd, nsxRootPw: pwd, nsxAuditPw: pwd,
      vdsProfile: 'default', vds1Name: 'sfo-m01-cl01-vds01', vds1Nics: 'vmnic0,vmnic1',
      opsA: 'flt-ops01a.rainpole.io', opsB: 'flt-ops01b.rainpole.io', opsC: 'flt-ops01c.rainpole.io', opsLb: 'flt-ops01.rainpole.io', opsAdminPw: pwd, opsRootPw: pwd,
      collectorFqdn: 'sfo-cp01.sfo.rainpole.io', collectorPw: pwd, licenseFqdn: 'flt-lc01.rainpole.io',
      fleetFqdn: 'flt-fc01.rainpole.io', instanceFqdn: 'sfo-ic01.sfo.rainpole.io', idbFqdn: 'flt-idb01.rainpole.io', platformFqdn: 'sfo-sr01.sfo.rainpole.io', vspPw: pwd,
      autoFqdn: 'flt-auto01.rainpole.io', autoPlatformFqdn: 'flt-vcfa-sr01.rainpole.io', autoAdminPw: pwd, autoCidr: '240.0.0.0/15', autoPrefix: 'flt-auto',
      sddcFqdn: 'sfo-vcf01.sfo.rainpole.io', sddcRootPw: 'VMw@re1!VMw@re1!', sddcVcfPw: 'VMw@re1!VMw@re1!', sddcLocalPw: 'VMw@re1!VMw@re1!',
    };
  };

  App.register(form);
})();
