import { describe, expect, it } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import { parseObjects } from '../src/lib/vsphere.js';
import { mapVsphere } from '../src/discovery/vmware.js';

// shape of a RetrievePropertiesEx response as returned by ESXi (trimmed)
const vmXml = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>
<RetrievePropertiesExResponse xmlns="urn:vim25"><returnval>
 <objects><obj type="VirtualMachine">1</obj>
  <propSet><name>name</name><val xsi:type="xsd:string">app01</val></propSet>
  <propSet><name>config.instanceUuid</name><val xsi:type="xsd:string">5012ABCD-0000</val></propSet>
  <propSet><name>runtime.host</name><val type="HostSystem" xsi:type="ManagedObjectReference">ha-host</val></propSet>
  <propSet><name>runtime.powerState</name><val xsi:type="VirtualMachinePowerState">poweredOn</val></propSet>
  <propSet><name>guest.ipAddress</name><val xsi:type="xsd:string">10.1.1.155</val></propSet>
  <propSet><name>guest.net</name><val xsi:type="ArrayOfGuestNicInfo"><GuestNicInfo xsi:type="GuestNicInfo"><network>VM Network</network><ipAddress>10.1.1.155</ipAddress><ipAddress>fe80::1</ipAddress><macAddress>00:50:56:aa:bb:cc</macAddress><connected>true</connected></GuestNicInfo></val></propSet>
  <propSet><name>datastore</name><val xsi:type="ArrayOfManagedObjectReference"><ManagedObjectReference type="Datastore" xsi:type="ManagedObjectReference">ds-1</ManagedObjectReference></val></propSet>
  <propSet><name>config.template</name><val xsi:type="xsd:boolean">false</val></propSet>
 </objects>
</returnval></RetrievePropertiesExResponse></soapenv:Body></soapenv:Envelope>`;
const hostXml = vmXml.replace(/<objects>[\s\S]*<\/objects>/, `<objects><obj type="HostSystem">ha-host</obj>
  <propSet><name>name</name><val xsi:type="xsd:string">esx1.lab</val></propSet>
  <propSet><name>config.network.vnic</name><val xsi:type="ArrayOfHostVirtualNic"><HostVirtualNic xsi:type="HostVirtualNic"><device>vmk0</device><spec><ip><dhcp>false</dhcp><ipAddress>10.1.1.254</ipAddress></ip><mac>00:11:22:33:44:55</mac></spec></HostVirtualNic></val></propSet>
  <propSet><name>datastore</name><val xsi:type="ArrayOfManagedObjectReference"><ManagedObjectReference type="Datastore" xsi:type="ManagedObjectReference">ds-1</ManagedObjectReference></val></propSet>
  <propSet><name>runtime.connectionState</name><val xsi:type="HostSystemConnectionState">connected</val></propSet></objects>`);
const dsXml = vmXml.replace(/<objects>[\s\S]*<\/objects>/, `<objects><obj type="Datastore">ds-1</obj>
  <propSet><name>name</name><val xsi:type="xsd:string">nfs-vms</val></propSet>
  <propSet><name>summary.type</name><val xsi:type="xsd:string">NFS</val></propSet>
  <propSet><name>info</name><val xsi:type="NasDatastoreInfo"><name>nfs-vms</name><nas><type>NFS</type><name>nfs-vms</name><remoteHost>10.1.1.20</remoteHost><remotePath>/volume1/vms</remotePath></nas></val></propSet></objects>`);

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false, isArray: (n) => ['objects', 'propSet', 'returnval'].includes(n) });
const objs = (xml: string) => parseObjects(parser.parse(xml).Envelope.Body.RetrievePropertiesExResponse.returnval[0]);

describe('vSphere mapping', () => {
  it('maps hosts, VMs with guest IPs and NFS datastores', () => {
    const items = mapVsphere(objs(hostXml), objs(vmXml), objs(dsXml), '10.1.1.254');
    const hv = items.find((i) => i.kind === 'hypervisor')!;
    const vm = items.find((i) => i.kind === 'vm')!;
    expect(hv).toMatchObject({ identityKey: 'vmware-host:esx1.lab', connection: { host: '10.1.1.254' } });
    expect(hv.attributes.datastores).toEqual([{ name: 'nfs-vms', type: 'NFS', remote_host: '10.1.1.20', remote_path: '/volume1/vms' }]);
    expect(vm).toMatchObject({ identityKey: 'vmware-vm:5012abcd-0000', name: 'app01', parentIdentityKey: 'vmware-host:esx1.lab', running: true, connection: { host: '10.1.1.155' } });
    expect(vm.attributes).toMatchObject({ ips: ['10.1.1.155'], macs: ['00:50:56:aa:bb:cc'], state: 'poweredOn' });
  });
});
