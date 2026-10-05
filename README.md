# VCF 9 JSON Generator

Web version of the VCF 9.1.1 Planning and Preparation Workbook. Fill in a form, get the JSON for the VCF Installer and SDDC Manager, validate it, and open existing JSON files to edit them.

Static HTML/JS. No build step, no backend, nothing leaves the browser. The page never connects to VCF or any other system: a Content-Security-Policy (`connect-src 'none'`) makes the browser block all network requests from the page.

## Run

Open `index.html` in a browser, or serve the folder:

```
python3 -m http.server 8080
```

It also works as a GitHub Pages site.

## Workflows and output files

| Tab | Files | API |
|---|---|---|
| Management Domain | VCF Installer spec (SddcSpec, new fleet) | `POST /v1/sddcs` (validate: `POST /v1/sddcs/validations`) or upload in the VCF Installer UI |
| Workload Domain | 1. network pool, 2. host commissioning (API and UI variants), 3. domain spec | `POST /v1/network-pools`, `POST /v1/hosts`, `POST /v1/domains` |
| Deploy Cluster | 1. network pool, 2. host commissioning (API and UI variants), 3. cluster spec (ClusterCreationSpec) | `POST /v1/network-pools`, `POST /v1/hosts`, `POST /v1/clusters` (validate: `POST /v1/clusters/validations`) |
| Stretch vSAN Cluster (Day-2) | 1. AZ2 network pool, 2. AZ2 host commissioning, 3. cluster stretch spec | `POST /v1/network-pools`, `POST /v1/hosts`, `PATCH /v1/clusters/{id}` |

Host IDs, network pool IDs, the domain ID and the cluster image ID only exist after earlier steps. Get them with **Get from VCF**, paste them into the form, or leave them empty and replace the `<--ENTER-...-->` placeholders in the JSON.

With **Cluster type: Multi-rack Layer 3** (Workload Domain and Deploy Cluster) each additional rack (up to 8 racks) gets its own section: network pool (one file per rack), hosts, host overlay VLAN and IP pool, uplink profile and network profile. Hosts reference the network profile of their rack; the rack 1 profile is the default.

### Get from VCF

Fields that need values from the running environment have a **Get from VCF** panel with copy-ready one-liners, built from what you already entered (SDDC Manager, vCenter and NSX FQDNs in "Lookup command settings"). The page does not run them: you copy a command, run it yourself in your own shell, and paste the output back:

| Field | Source | Commands |
|---|---|---|
| Workload domain ID (Deploy Cluster) | SDDC Manager `GET /v1/domains` | curl + jq, `Invoke-VcfGetDomains` |
| Cluster image ID (Workload Domain, Deploy Cluster) | SDDC Manager `GET /v1/personalities` | curl + jq, `Invoke-VcfGetPersonalities` |
| Network pool ID, host IDs (all Day-N tabs, per rack) | SDDC Manager `GET /v1/network-pools`, `GET /v1/hosts?status=UNASSIGNED_USEABLE` | curl + jq, `Invoke-VcfGetNetworkPool`, `Invoke-VcfGetHosts` |
| Remote vSAN datastore UUID (vSAN compute cluster) | vCenter of the vSAN storage cluster | `govc`, PowerCLI `Get-Datastore` |
| Overlay / VLAN transport zone names (Deploy Cluster) | NSX Manager `GET /policy/api/v1/infra/sites/default/enforcement-points/default/transport-zones` | curl + jq, `Invoke-RestMethod` |
| Cluster ID, vSAN architecture, NSX switch (Stretch) | SDDC Manager `GET /v1/clusters` | curl + jq, VCF PowerCLI `Invoke-VcfGetClusters` |
| vmnic / switch / uplink mapping | vCenter | PowerCLI `Get-VDPort -Uplink` (esxcli as fallback) |
| Witness vSAN IP and subnet | witness host | esxcli over SSH, PowerCLI `Get-VMHostNetworkAdapter` |
| Existing TEP IP pools | NSX Manager `GET /policy/api/v1/infra/ip-pools` | curl + jq, `Invoke-RestMethod` |

Passwords are prompted when the command runs and are never stored in the form. Paste the command output into the panel and click **Fill form** to fill the fields.

## Using the form

- Grey text in a field is either the workbook sample (`e.g. ...`) or the value that will be generated if you leave it empty (`Auto: ...`).
- Values already entered on an earlier tab are reused as `Auto:` defaults: SDDC Manager FQDN and user, DNS / NTP servers (Supervisor) and the management vCenter, NSX VIP and cluster (Stretch) from the Management Domain tab; domain name, NSX VIP, vCenter, transport zones and host overlay VLAN (Deploy Cluster) from the Workload Domain tab. Type a value to override.
- Click a field or its `?` button: the Help panel explains the field, every drop-down alternative, the JSON property it maps to and the official API description.
- **Load sample** fills the current tab with the workbook sample values.
- State is autosaved in the browser (localStorage). **Save project** writes all tabs to one file, including choices that are not part of the JSON; load it again with **Open / validate JSON**.

## Validation

Three layers, shown in the Issues tab and next to each field:

1. Field rules: required values, FQDN/IP/CIDR/VLAN/MTU formats, password rules from the API documentation.
2. Network and dependency rules: gateways and ranges inside their subnet, range sizes against host count, overlapping subnets, workload domain / cluster VLANs or subnets that are already used by the management domain (compared with the Management Domain tab), duplicate FQDNs and NICs, MTU against switch MTU, deployment-model rules (VCF Automation and management services ranges, HA vs Simple), vSAN host minimums.
3. Schema check of the generated JSON against the official 9.1.1 API data structures (`js/schema.js`).

## Open existing JSON

**Open / validate JSON** accepts a file or pasted text. The type is detected automatically (SddcSpec, DomainCreationSpec, ClusterCreationSpec, ClusterUpdateSpec / ClusterStretchSpec, or a project file).

- **Validate only** checks the file against the API schema without loading it.
- **Load into form** maps the JSON into the form. Top-level fields the form does not handle are kept unchanged in the output. Short host names are expanded with the DNS domain.
- When every host in an imported workload domain, cluster or stretch spec has an SDDC Manager host ID, the hosts are treated as already commissioned (**Hosts are already commissioned**): only the spec itself is generated, without network pool and commissioning files.
- `hostname` (host specs), `isDefault` (stretch network profiles) and `name` (uplink profile teamings) are not in the 9.1.1 API reference but appear in specs that SDDC Manager accepted; they are reported as info, not warnings. Generated specs use the documented `hostName` and leave the other two out.

**Download without passwords** removes every password field, for sharing or version control.

## Sources

- `js/schema.js` is generated from the VCF Installer API and SDDC Manager API reference on developer.broadcom.com: `python3 tools/fetch_schema.py`.
- JSON structure and defaults follow the official VCF.JSONGenerator PowerShell module that accompanies the workbook (for example VDS profiles, LAG uplink naming `<lag>-0`, transport zone names, VCF management services size by deployment model).

## Workbook options covered

The forms follow the choices of the workbook sheets:

- **Deploy Management Domain:** new VCF fleet or new instance in an existing fleet (`VCF_EXTEND`), deployment model, Size, Customize appliance sizing, VM / VCF management network layout, VPC network configuration and gateway connectivity, storage (vSAN ESA/OSA, NFS, FC, data-in-transit, FTT, deduplication and compression for ESA and OSA), DNS/NTP, hosts, all networks and IP ranges, host overlay (IP pool or DHCP), VCF Operations (per-node root passwords), management services, VCF Automation, vCenter (incl. SSO username), switch profiles, LAG, port group load balancing and uplink order, NSX operational mode and teaming, SDDC Manager, auto-generated passwords.
- **Deploy Workload Domain:** full deployment or infrastructure only, network pool create or re-use, static or DHCP pool networks, principal storage incl. vSAN Storage Cluster (vSAN Max), secondary storage network (NFS or vSAN storage client), FTT 1-3, NSX create or join, optional appliance IPs, VLAN transport zone, VPC options, VNA, TEP pool, uplink profile and teaming, vSphere Supervisor.
- **Deploy Cluster:** network pool create or re-use, principal storage incl. vSAN Storage Cluster and vSAN Compute Cluster (remote datastore, remote data-in-transit encryption), secondary storage network, switch profiles and LAG, port groups, NSX transport zones, host overlay (new or existing IP pool), uplink profile and teaming, vSphere Supervisor.
- **Additional Racks (Layer 3 multi-rack):** per rack network pool, hosts, host overlay VLAN / IP pool, uplink profile and network profile. ESX management networks per rack and vSAN fault domains are configured outside the JSON.
- **Configure Management/Workload Domain - vSAN Stretched Cluster:** network pool create or re-use, AZ2 hosts, witness, AZ2 host overlay (IP pool or DHCP, new or existing pool).

## Not covered

- Dual-stack (IPv6) networking: the installer JSON format for IPv6 networks is not documented in the 9.1.1 API reference.
- Import Workload Domain / existing vCenter or NSX (nothing to import in a greenfield).
- VVF, vVols, stretched vSAN compute clusters.
- Depot, proxy and download token (configured in the VCF Installer UI, not in the JSON). VCF Installer location has no effect on the JSON.

## Verify before production use

- Workload domains write `vpcNetworkConfigurationType` only for infrastructure-only (shell) domains, as documented in the API; full domains use `overlayVtepSpec.vtepType = NO_IP` for VLAN backed VPC.
- VLAN-backed VPC in the management domain is written as `vpcSpec.vpcNetworkConfigurationType = VLAN_BACKED_VPC` plus `overlayVtepSpec.vtepType = NO_IP`.
- Stretching a cluster whose hosts have no TEPs (VCF 9.1.1 VLAN backed VPC only) sends no `networkSpec` or `secondaryAzOverlayVlanId`; both are optional in the API. Clusters with TEPs (all 9.0 / 9.1.0 management domains, Full Stack VPC) need the AZ2 overlay section.
- vSAN compute clusters send the datastore container ID from vCenter as `datastoreUuid`; check the format against `POST /v1/clusters/validations`.
- The VCF PowerCLI cmdlet names in the lookups follow the SDDC Manager API operation names and were not run against a real PowerCLI installation; the curl + jq variants were tested against a mock API.
- Always run the validation API (or the installer pre-checks) before deploying.
