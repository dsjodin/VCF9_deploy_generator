# VCF 9 JSON Generator

Web version of the VCF 9.1.1 Planning and Preparation Workbook. Fill in a form, get the JSON for the VCF Installer and SDDC Manager, validate it, and open existing JSON files to edit them.

Static HTML/JS. No build step, no backend, nothing leaves the browser.

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
| Stretch vSAN Cluster (Day-2) | 1. AZ2 network pool, 2. AZ2 host commissioning, 3. cluster stretch spec | `POST /v1/network-pools`, `POST /v1/hosts`, `PATCH /v1/clusters/{id}` |

Host IDs, network pool IDs and the cluster image ID only exist after earlier steps. Paste them into the form, or leave them empty and replace the `<--ENTER-...-->` placeholders in the JSON.

### Get from VCF (Stretch vSAN Cluster)

Fields that need values from the running environment have a **Get from VCF** panel with copy-ready one-liners, built from what you already entered (SDDC Manager, vCenter and NSX FQDNs in "Connection to VCF"):

| Field | Source | Commands |
|---|---|---|
| Cluster ID, vSAN architecture, NSX switch | SDDC Manager `GET /v1/clusters` | curl + jq, VCF PowerCLI `Invoke-VcfGetClusters` |
| Network pool ID | SDDC Manager `GET /v1/network-pools` | curl + jq, `Invoke-VcfGetNetworkPool` |
| AZ2 host IDs | SDDC Manager `GET /v1/hosts?status=UNASSIGNED_USEABLE` | curl + jq, `Invoke-VcfGetHosts` |
| vmnic / switch / uplink mapping | vCenter | PowerCLI `Get-VDPort -Uplink` (esxcli as fallback) |
| Witness vSAN IP and subnet | witness host | esxcli over SSH, PowerCLI `Get-VMHostNetworkAdapter` |
| Existing TEP IP pools | NSX Manager `GET /policy/api/v1/infra/ip-pools` | curl + jq, `Invoke-RestMethod` |

Passwords are prompted when the command runs and are never stored in the form. Paste the command output into the panel and click **Fill form** to fill the fields.

## Using the form

- Grey text in a field is either the workbook sample (`e.g. ...`) or the value that will be generated if you leave it empty (`Auto: ...`).
- Click a field or its `?` button: the Help panel explains the field, every drop-down alternative, the JSON property it maps to and the official API description.
- **Load sample** fills the current tab with the workbook sample values.
- State is autosaved in the browser (localStorage). **Save project** writes all three tabs to one file, including choices that are not part of the JSON; load it again with **Open / validate JSON**.

## Validation

Three layers, shown in the Issues tab and next to each field:

1. Field rules: required values, FQDN/IP/CIDR/VLAN/MTU formats, password rules from the API documentation.
2. Network and dependency rules: gateways and ranges inside their subnet, range sizes against host count, overlapping subnets, duplicate FQDNs and NICs, MTU against switch MTU, deployment-model rules (VCF Automation and management services ranges, HA vs Simple), vSAN host minimums.
3. Schema check of the generated JSON against the official 9.1.1 API data structures (`js/schema.js`).

## Open existing JSON

**Open / validate JSON** accepts a file or pasted text. The type is detected automatically (SddcSpec, DomainCreationSpec, ClusterUpdateSpec / ClusterStretchSpec, or a project file).

- **Validate only** checks the file against the API schema without loading it.
- **Load into form** maps the JSON into the form. Top-level fields the form does not handle are kept unchanged in the output. Short host names are expanded with the DNS domain.

**Download without passwords** removes every password field, for sharing or version control.

## Sources

- `js/schema.js` is generated from the VCF Installer API and SDDC Manager API reference on developer.broadcom.com: `python3 tools/fetch_schema.py`.
- JSON structure and defaults follow the official VCF.JSONGenerator PowerShell module that accompanies the workbook (for example VDS profiles, LAG uplink naming `<lag>-0`, transport zone names, VCF management services size by deployment model).

## Not covered

- Secondary instance (`VCF_EXTEND`), converting existing vCenter/NSX, VVF.
- Dual-stack IPv6, multi-rack L3 clusters, vSAN Max / compute-only clusters, additional clusters.
- Depot, proxy and download token (configured in the VCF Installer UI, not in the JSON).

## Verify before production use

- VLAN-backed VPC in the management domain is written as `vpcSpec.vpcNetworkConfigurationType = VLAN_BACKED_VPC` plus `overlayVtepSpec.vtepType = NO_IP`.
- Stretching a VLAN-backed cluster (no host TEPs, typical for the management domain) sends no `networkSpec`, `secondaryAzOverlayVlanId` or `isEdgeClusterConfiguredForMultiAZ`; these are optional in the API.
- Always run the validation API (or the installer pre-checks) before deploying.
