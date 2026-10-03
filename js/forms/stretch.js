// SDDC Manager Day-2: stretch a vSAN cluster to a second availability zone (ClusterUpdateSpec.clusterStretchSpec).
(function () {
  const C = Common;
  const N = Net;
  const HOST_ID_PH = '<--ENTER-SDDC-HOST-ID-->';
  const POOL_ID_PH = '<--ENTER-NETWORK-POOL-ID-->';
  const pool = s => s.tepMode === 'pool';
  const newPool = s => pool(s) && !s.tepReuse;

  function poolNet(p, title, o) {
    return [
      { type: 'note', text: '<b>' + title + '</b>' },
      { id: p + 'Vlan', label: 'VLAN ID', type: 'text', fmt: 'vlan', req: true, ph: o.vlan, help: 'AZ2 VLAN for this network. AZ2 normally uses different VLANs and subnets than AZ1 (L3 between sites).', api: 'networks[].vlanId' },
      { id: p + 'Mtu', label: 'MTU', type: 'text', fmt: 'mtu', req: true, def: '9000', help: 'MTU for the network.', api: 'networks[].mtu' },
      { id: p + 'Gw', label: 'Gateway (CIDR notation)', type: 'text', fmt: 'gwcidr', req: true, ph: o.gw, help: 'AZ2 gateway with prefix length.', api: 'networks[].gateway' },
      { id: p + 'Start', label: 'IP range start', type: 'text', fmt: 'ipv4', req: true, ph: o.start, help: 'First address (one per AZ2 host).', api: 'networks[].ipPools[].start' },
      { id: p + 'End', label: 'IP range end', type: 'text', fmt: 'ipv4', req: true, ph: o.end, help: 'Last address.', api: 'networks[].ipPools[].end' },
    ];
  }

  const P = 'clusterStretchSpec.networkSpec.nsxClusterSpec';

  const form = {
    id: 'stretch',
    tab: 'Stretch vSAN Cluster',
    title: 'Day-2: Stretch a vSAN cluster to a second availability zone',
    intro: 'Generates the files to stretch an existing vSAN cluster (management or workload domain) across two availability zones: <b>1)</b> AZ2 network pool, <b>2)</b> AZ2 host commissioning, <b>3)</b> the cluster stretch spec. Deploy and configure the vSAN witness host first (OVA in a third site, registered in a vCenter outside the stretched cluster), and make sure routing exists between AZ1, AZ2 and the witness vSAN networks.',
    schema: { api: 'sddc-manager-api', root: 'ClusterUpdateSpec' },
    sections: [
      {
        id: 'target', title: 'Target cluster',
        fields: [
          { id: 'clusterName', label: 'Cluster name', type: 'text', req: true, ph: 'sfo-m01-cl01', help: 'Name of the vSAN cluster to stretch (used for file names and documentation).' },
          { id: 'clusterId', label: 'SDDC Manager cluster ID', type: 'text', help: 'UUID of the cluster from <code>GET /v1/clusters</code>. Used in the API path <code>PATCH /v1/clusters/{id}</code>. Not part of the JSON body.' },
          { id: 'vsanType', label: 'vSAN architecture', type: 'select', def: 'vsan-esa', options: C.storage.slice(0, 2), help: 'Architecture of the existing cluster. Determines the commissioning storage type.' },
          { id: 'edgeMultiAz', label: 'Edge cluster is configured for multi-AZ', type: 'checkbox', def: true, help: 'Acknowledge that the NSX Edge cluster networking (uplink VLANs, BGP to AZ2 top-of-rack, route maps) is prepared to work after a site failover.', api: 'clusterStretchSpec.isEdgeClusterConfiguredForMultiAZ' },
          { id: 'noLicense', label: 'Deploy without license keys', type: 'checkbox', def: true, help: 'VCF 9 licenses through VCF Operations.', api: 'clusterStretchSpec.deployWithoutLicenseKeys' },
        ],
      },
      {
        id: 'witness', title: 'vSAN witness',
        intro: 'The witness host must already be deployed and reachable from the vSAN networks of both AZs.',
        fields: [
          { id: 'witnessFqdn', label: 'Witness FQDN', type: 'text', fmt: 'fqdn', req: true, ph: 'sfo-m01-cl01-vsw01.sfo.rainpole.io', help: 'FQDN (management address) of the vSAN witness appliance.', api: 'clusterStretchSpec.witnessSpec.fqdn' },
          { id: 'witnessIp', label: 'Witness vSAN IP', type: 'text', fmt: 'ipv4', req: true, ph: '10.17.10.218', help: 'IP address of the witness VMkernel adapter that carries vSAN witness traffic.', api: 'clusterStretchSpec.witnessSpec.vsanIp' },
          { id: 'witnessCidr', label: 'Witness vSAN subnet (CIDR)', type: 'text', fmt: 'netcidr', req: true, ph: '10.17.10.0/24', help: 'Network address and prefix of the witness vSAN subnet, e.g. <code>10.17.10.0/24</code>.', api: 'clusterStretchSpec.witnessSpec.vsanCidr' },
          { id: 'witnessShared', label: 'Witness traffic shared with vSAN traffic', type: 'checkbox', def: false, help: 'Off (default): witness traffic uses the ESX management VMkernel (witness traffic separation). On: witness traffic shares the vSAN VMkernel.', api: 'clusterStretchSpec.witnessTrafficSharedWithVsanTraffic' },
        ],
      },
      {
        id: 'pool', title: '1. AZ2 network pool',
        fields: [
          { id: 'poolName', label: 'Network pool name', type: 'text', auto: (s, g) => g('clusterName') ? g('clusterName') + '-az2-np01' : '', help: 'Name of the AZ2 network pool in SDDC Manager.', api: 'name' },
          ...poolNet('vmotion', 'vMotion (AZ2)', { vlan: '1212', gw: '10.12.12.1/24', start: '10.12.12.101', end: '10.12.12.116' }),
          ...poolNet('vsan', 'vSAN (AZ2)', { vlan: '1213', gw: '10.12.13.1/24', start: '10.12.13.101', end: '10.12.13.116' }),
        ],
      },
      {
        id: 'hosts', title: '2. AZ2 hosts',
        intro: 'Add the same number of hosts in AZ2 as in AZ1. Commission them into the AZ2 network pool, then copy their IDs here.',
        fields: [
          { id: 'esxPw', label: 'ESX root password', type: 'password', req: true, pw: C.pw.esx, help: 'Root password of the AZ2 hosts.', api: 'password' },
          { id: 'poolId', label: 'Network pool ID', type: 'text', help: 'ID of the AZ2 network pool (GET /v1/network-pools). Leave empty to keep a placeholder.', api: 'networkPoolId' },
          {
            id: 'hosts', label: 'AZ2 hosts', type: 'rows', min: 1, max: 32, initial: 4, addLabel: 'Add host',
            columns: [
              { id: 'fqdn', label: 'Host FQDN', type: 'text', fmt: 'fqdn', req: true, ph: (s, g, i) => 'sfo02-m01-r01-esx0' + ((i || 0) + 1) + '.sfo.rainpole.io', help: 'AZ2 host FQDN.', api: 'clusterStretchSpec.hostSpecs[].hostName' },
              { id: 'id', label: 'SDDC Manager host ID', type: 'text', help: 'UUID after commissioning (GET /v1/hosts?status=UNASSIGNED_USEABLE).', api: 'clusterStretchSpec.hostSpecs[].id', check: v => /^[0-9a-fA-F-]{36}$/.test(v) || { level: 'warn', msg: 'Host IDs are normally UUIDs' } },
            ],
          },
          {
            id: 'nics', label: 'Physical NIC mapping (same as the AZ1 hosts)', type: 'rows', min: 2, max: 8, initial: 2, addLabel: 'Add NIC',
            hint: 'Map every vmnic to the distributed switch and uplink it uses in the existing cluster.',
            columns: [
              { id: 'id', label: 'vmnic', type: 'text', fmt: 'vmnic', req: true, def: '', ph: (s, g, i) => 'vmnic' + (i || 0), help: 'Physical NIC name.', api: 'clusterStretchSpec.hostSpecs[].hostNetworkSpec.vmNics[].id' },
              { id: 'vds', label: 'Distributed switch', type: 'text', req: true, ph: 'sfo-m01-cl01-vds01', help: 'Name of the existing distributed switch of the cluster.', api: 'clusterStretchSpec.hostSpecs[].hostNetworkSpec.vmNics[].vdsName' },
              { id: 'uplink', label: 'Uplink', type: 'text', req: true, ph: (s, g, i) => 'uplink' + ((i || 0) + 1), help: 'VDS uplink name (uplink1, uplink2 ... or &lt;lag&gt;-0 for a LAG).', api: 'clusterStretchSpec.hostSpecs[].hostNetworkSpec.vmNics[].uplink' },
            ],
          },
        ],
      },
      {
        id: 'overlay', title: '3. AZ2 host overlay (NSX TEP)',
        fields: [
          { id: 'tepVlan', label: 'AZ2 host overlay VLAN', type: 'text', fmt: 'vlan', req: true, ph: '1214', help: 'VLAN for AZ2 host TEPs.', api: P + '.uplinkProfiles[].transportVlan' },
          { id: 'tepMode', label: 'TEP IP assignment', type: 'select', options: C.tepMode, def: 'pool', rerender: true, help: 'How AZ2 TEPs get IPs.' },
          { id: 'nsxVds', label: 'NSX distributed switch', type: 'text', req: true, show: pool, auto: s => ((s.nics || [])[0] || {}).vds || '', help: 'Distributed switch of the cluster that is prepared for NSX.', api: 'clusterStretchSpec.networkSpec.networkProfiles[].nsxtHostSwitchConfigs[].vdsName' },
          { id: 'tepPoolName', label: 'AZ2 IP pool name', type: 'text', show: pool, auto: (s, g) => g('clusterName') ? g('clusterName') + '-az2-tep01' : '', pattern: '^[a-zA-Z0-9-_]+$', patternMsg: 'Letters, digits, - and _ only', help: 'Name of the NSX IP pool for AZ2 TEPs.', api: P + '.ipAddressPoolsSpec[].name' },
          { id: 'tepReuse', label: 'Re-use an existing IP pool', type: 'checkbox', show: pool, rerender: true, help: 'Reference an existing NSX IP pool by name only.' },
          { id: 'tepGw', label: 'Gateway (CIDR notation)', type: 'text', fmt: 'gwcidr', req: true, show: newPool, ph: '10.12.14.1/24', help: 'AZ2 TEP subnet gateway with prefix.', api: P + '.ipAddressPoolsSpec[].subnets[].gateway' },
          { id: 'tepStart', label: 'IP pool start', type: 'text', fmt: 'ipv4', req: true, show: newPool, ph: '10.12.14.101', help: 'First AZ2 TEP address.', api: P + '.ipAddressPoolsSpec[].subnets[].ipAddressPoolRanges[].start' },
          { id: 'tepEnd', label: 'IP pool end', type: 'text', fmt: 'ipv4', req: true, show: newPool, ph: '10.12.14.132', help: 'Last AZ2 TEP address.', api: P + '.ipAddressPoolsSpec[].subnets[].ipAddressPoolRanges[].end' },
          { id: 'uplinkProfile', label: 'AZ2 uplink profile name', type: 'text', show: pool, auto: (s, g) => g('clusterName') ? g('clusterName') + '-az2-uplink-profile01' : '', help: 'NSX uplink profile for AZ2 hosts (carries the AZ2 transport VLAN).', api: P + '.uplinkProfiles[].name' },
          { id: 'netProfile', label: 'AZ2 network profile name', type: 'text', show: pool, auto: (s, g) => g('clusterName') ? g('clusterName') + '-az2-network-profile01' : '', help: 'SDDC Manager network profile assigned to the AZ2 hosts.', api: 'clusterStretchSpec.networkSpec.networkProfiles[].name' },
          { id: 'nsxTeam', label: 'NSX teaming policy', type: 'select', options: C.nsxTeaming, def: 'LOADBALANCE_SRCID', show: pool, help: 'Teaming of the AZ2 uplink profile.', api: P + '.uplinkProfiles[].teamings[].policy' },
        ],
      },
    ],
  };

  form.rules = function (s, g) {
    const out = [];
    const hosts = s.hosts.filter(h => (h.fqdn || '').trim());
    const missing = hosts.filter(h => !(h.id || '').trim()).length;
    if (missing) out.push({ level: 'warn', field: 'hosts', msg: missing + ' AZ2 host(s) without SDDC Manager host ID; placeholders are written to the JSON' });
    if (!(s.clusterId || '').trim()) out.push({ level: 'info', field: 'clusterId', msg: 'Cluster ID is empty; replace {id} in PATCH /v1/clusters/{id} when submitting' });
    const n = hosts.length;
    C.rangeRules(out, { label: 'AZ2 vMotion', gw: s.vmotionGw, start: s.vmotionStart, end: s.vmotionEnd, fieldStart: 'vmotionStart', fieldEnd: 'vmotionEnd', need: n, needMsg: 'needs one per AZ2 host (' + n + ')' });
    C.rangeRules(out, { label: 'AZ2 vSAN', gw: s.vsanGw, start: s.vsanStart, end: s.vsanEnd, fieldStart: 'vsanStart', fieldEnd: 'vsanEnd', need: n, needMsg: 'needs one per AZ2 host (' + n + ')' });
    if (newPool(s)) {
      const nsxUplinks = s.nics.filter(x => (x.vds || '').trim() === g('nsxVds')).length || 2;
      C.rangeRules(out, { label: 'AZ2 TEP pool', gw: s.tepGw, start: s.tepStart, end: s.tepEnd, fieldStart: 'tepStart', fieldEnd: 'tepEnd', need: n * nsxUplinks, needMsg: 'needs ' + n * nsxUplinks + ' (one per host uplink)' });
    }
    if (N.isCidr(s.witnessCidr) && N.isIPv4(s.witnessIp) && !N.inSubnet(s.witnessIp, s.witnessCidr)) out.push({ level: 'error', field: 'witnessIp', msg: 'Witness vSAN IP is not inside the witness vSAN subnet' });
    for (const [a, b] of [['vmotion', 'vsan'], ['vmotion', 'tep'], ['vsan', 'tep']]) {
      if ((a === 'tep' || b === 'tep') && !newPool(s)) continue;
      if (N.cidrsOverlap(s[a + 'Gw'], s[b + 'Gw'])) out.push({ level: 'error', field: b + 'Gw', msg: b + ' subnet overlaps ' + a });
    }
    if (N.isCidr(s.witnessCidr) && N.cidrsOverlap(s.witnessCidr, s.vsanGw)) out.push({ level: 'error', field: 'witnessCidr', msg: 'Witness vSAN subnet must be routed, not the same as the AZ2 vSAN subnet' });
    const seen = {};
    s.nics.forEach((x, i) => {
      if (x.id && seen[x.id]) out.push({ level: 'error', field: 'nics.' + i + '.id', msg: x.id + ' is mapped twice' });
      seen[x.id] = 1;
    });
    return out;
  };

  function poolNetwork(s, type, p) {
    const c = N.parseCidr(s[p + 'Gw']);
    return { type, vlanId: C.int(s[p + 'Vlan']), mtu: C.int(s[p + 'Mtu']), subnet: c ? c.network : '', mask: c ? c.mask : '', gateway: c ? c.ip : '', ipPools: [{ start: s[p + 'Start'], end: s[p + 'End'] }] };
  }

  form.build = function (s, g) {
    const files = [];
    const base = (g('clusterName') || 'cluster') + '-stretch';
    files.push({
      name: base + '-1-az2-network-pool.json', title: 'AZ2 network pool',
      json: { name: g('poolName'), networks: [poolNetwork(s, 'VMOTION', 'vmotion'), poolNetwork(s, 'VSAN', 'vsan')] },
      method: 'POST', endpoint: '/v1/network-pools', schema: { api: 'sddc-manager-api', type: 'NetworkPool' },
    });
    const hostRows = s.hosts.filter(h => (h.fqdn || '').trim());
    const storageType = C.storageTypeCommission[s.vsanType];
    const commission = hostRows.map(h => ({ fqdn: h.fqdn.trim(), username: 'root', password: s.esxPw, storageType, networkPoolId: (s.poolId || '').trim() || POOL_ID_PH, networkPoolName: g('poolName') }));
    files.push({
      name: base + '-2-commission-az2-hosts-api.json', title: 'Commission AZ2 hosts (API)', json: commission,
      method: 'POST', endpoint: '/v1/hosts  (validate first: POST /v1/hosts/validations)', schema: { api: 'sddc-manager-api', type: 'HostCommissionSpec' },
    });
    files.push({
      name: base + '-2-commission-az2-hosts-ui.json', title: 'Commission AZ2 hosts (UI import)',
      json: { hosts: commission.map(h => ({ fqdn: h.fqdn, username: h.username, storageType: h.storageType, password: h.password, networkPoolName: h.networkPoolName })) },
      note: 'SDDC Manager UI: Hosts &gt; Commission Hosts &gt; Import (JSON).',
    });

    const vmNics = s.nics.filter(x => (x.id || '').trim()).map(x => ({ id: x.id.trim(), vdsName: (x.vds || '').trim(), uplink: (x.uplink || '').trim() }));
    const hostNetworkSpec = { vmNics };
    if (pool(s)) hostNetworkSpec.networkProfileName = g('netProfile');
    const spec = {
      hostSpecs: hostRows.map(h => ({ id: (h.id || '').trim() || HOST_ID_PH, hostName: h.fqdn.trim(), hostNetworkSpec })),
      witnessSpec: { fqdn: g('witnessFqdn'), vsanIp: g('witnessIp'), vsanCidr: g('witnessCidr') },
      witnessTrafficSharedWithVsanTraffic: !!s.witnessShared,
      isEdgeClusterConfiguredForMultiAZ: !!s.edgeMultiAz,
      deployWithoutLicenseKeys: !!s.noLicense,
    };
    if (pool(s)) {
      const nsxVds = g('nsxVds');
      const up = vmNics.filter(x => x.vdsName === nsxVds).map(x => x.uplink);
      const lag = up.length && up.every(u => /-\d+$/.test(u) && !/^uplink\d+$/.test(u)) ? up[0].replace(/-\d+$/, '') : null;
      const teaming = lag
        ? { policy: 'FAILOVER_ORDER', activeUplinks: [lag], standByUplinks: [] }
        : { policy: s.nsxTeam, activeUplinks: s.nsxTeam === 'FAILOVER_ORDER' ? up.slice(0, 1) : up, standByUplinks: s.nsxTeam === 'FAILOVER_ORDER' ? up.slice(1) : [] };
      const ipPool = { name: g('tepPoolName') };
      if (!s.tepReuse) {
        const c = N.parseCidr(s.tepGw);
        ipPool.subnets = [{ cidr: c ? c.cidr : '', gateway: c ? c.ip : '', ipAddressPoolRanges: [{ start: s.tepStart, end: s.tepEnd }] }];
      }
      const map = lag ? [{ vdsUplinkName: lag, nsxUplinkName: lag }] : up.map(u => ({ vdsUplinkName: u, nsxUplinkName: u }));
      spec.networkSpec = {
        nsxClusterSpec: { ipAddressPoolsSpec: [ipPool], uplinkProfiles: [{ name: g('uplinkProfile'), transportVlan: C.int(s.tepVlan), teamings: [teaming] }] },
        networkProfiles: [{ name: g('netProfile'), nsxtHostSwitchConfigs: [{ vdsName: nsxVds, uplinkProfileName: g('uplinkProfile'), ipAddressPoolName: g('tepPoolName'), vdsUplinkToNsxUplink: map }] }],
      };
    } else {
      spec.secondaryAzOverlayVlanId = C.int(s.tepVlan);
    }
    const id = (s.clusterId || '').trim() || '{id}';
    files.push({
      name: base + '-3-cluster-stretch.json', title: 'Cluster stretch spec', main: true, json: { clusterStretchSpec: spec },
      method: 'PATCH', endpoint: '/v1/clusters/' + id + '  (validate first: POST /v1/clusters/' + id + '/validations)',
      note: 'After stretching, configure NSX Tier-0 for AZ2 (IP prefixes, route maps, BGP neighbors) as described in the workbook.',
      schema: { api: 'sddc-manager-api', type: 'ClusterUpdateSpec' },
    });
    return files;
  };

  form.detect = j => j && !Array.isArray(j) && (!!j.clusterStretchSpec || (!!j.witnessSpec && !!j.hostSpecs));
  form.rawSchema = j => j.clusterStretchSpec ? { api: 'sddc-manager-api', type: 'ClusterUpdateSpec' } : { api: 'sddc-manager-api', type: 'ClusterStretchSpec' };

  form.fromJson = function (j) {
    const sp = j.clusterStretchSpec || j;
    const s = {};
    const notes = ['Network pool and commissioning values are not part of the stretch spec; fill in sections 1 and 2 if you need those files.'];
    const str = v => (v === undefined || v === null ? '' : String(v));
    const w = sp.witnessSpec || {};
    s.witnessFqdn = str(w.fqdn); s.witnessIp = str(w.vsanIp); s.witnessCidr = str(w.vsanCidr);
    s.witnessShared = !!sp.witnessTrafficSharedWithVsanTraffic;
    s.edgeMultiAz = sp.isEdgeClusterConfiguredForMultiAZ !== false;
    s.noLicense = sp.deployWithoutLicenseKeys !== false;
    const hs = sp.hostSpecs || [];
    s.hosts = hs.map(h => ({ fqdn: str(h.hostName || h.hostname), id: str(h.id).indexOf('<--') === 0 ? '' : str(h.id) }));
    const hn = (hs[0] || {}).hostNetworkSpec || {};
    s.nics = (hn.vmNics || []).map(x => ({ id: str(x.id), vds: str(x.vdsName), uplink: str(x.uplink) }));
    const ns = sp.networkSpec;
    if (ns) {
      s.tepMode = 'pool';
      const nc = ns.nsxClusterSpec || {};
      const up = (nc.uplinkProfiles || [])[0] || {};
      s.uplinkProfile = str(up.name); s.tepVlan = str(up.transportVlan);
      const t = (up.teamings || [])[0];
      if (t && t.policy) s.nsxTeam = t.policy;
      const ip = (nc.ipAddressPoolsSpec || [])[0];
      if (ip) {
        s.tepPoolName = str(ip.name);
        const sub = (ip.subnets || [])[0];
        if (sub) {
          const p = sub.cidr && sub.cidr.indexOf('/') > 0 ? sub.cidr.split('/')[1] : '24';
          s.tepGw = sub.gateway ? sub.gateway + '/' + p : '';
          const r = (sub.ipAddressPoolRanges || [])[0] || {};
          s.tepStart = str(r.start); s.tepEnd = str(r.end);
        } else s.tepReuse = true;
      }
      const np = (ns.networkProfiles || [])[0] || {};
      s.netProfile = str(np.name);
      s.nsxVds = str(((np.nsxtHostSwitchConfigs || [])[0] || {}).vdsName);
    } else {
      s.tepMode = 'dhcp';
      s.tepVlan = str(sp.secondaryAzOverlayVlanId);
    }
    const extra = {};
    for (const k of Object.keys(j)) if (k !== 'clusterStretchSpec' && j.clusterStretchSpec) extra[k] = j[k];
    if (Object.keys(extra).length) notes.push('Fields kept unchanged in the output: ' + Object.keys(extra).join(', '));
    return { state: s, extra, notes };
  };

  form.sample = function () {
    const hosts = [];
    for (let i = 1; i <= 4; i++) hosts.push({ fqdn: 'sfo02-m01-r01-esx0' + i + '.sfo.rainpole.io', id: '' });
    return {
      clusterName: 'sfo-m01-cl01', vsanType: 'vsan-esa', edgeMultiAz: true,
      witnessFqdn: 'sfo-m01-cl01-vsw01.sfo.rainpole.io', witnessIp: '10.17.10.218', witnessCidr: '10.17.10.0/24',
      poolName: 'sfo02-m01-r01-network-pool-01',
      vmotionVlan: '1212', vmotionMtu: '9000', vmotionGw: '10.12.12.1/24', vmotionStart: '10.12.12.101', vmotionEnd: '10.12.12.116',
      vsanVlan: '1213', vsanMtu: '9000', vsanGw: '10.12.13.1/24', vsanStart: '10.12.13.101', vsanEnd: '10.12.13.116',
      esxPw: 'VMw@re1!', hosts,
      nics: [{ id: 'vmnic0', vds: 'sfo-m01-cl01-vds01', uplink: 'uplink1' }, { id: 'vmnic1', vds: 'sfo-m01-cl01-vds01', uplink: 'uplink2' }],
      tepVlan: '1214', tepMode: 'pool', nsxVds: 'sfo-m01-cl01-vds01', tepPoolName: 'sfo02-m01-r01-ip-pool01-host',
      tepGw: '10.12.14.1/24', tepStart: '10.12.14.101', tepEnd: '10.12.14.132',
      uplinkProfile: 'sfo02-m01-r01-uplink-profile01', netProfile: 'sfo02-sfo-m01-cl01-r01-network-profile',
    };
  };

  App.register(form);
})();
