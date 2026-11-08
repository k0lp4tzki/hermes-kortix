import { Agent, request } from 'undici';
import { XMLParser } from 'fast-xml-parser';

/**
 * Minimal read-only vSphere Web Services (SOAP, vim25) client. Works against a standalone
 * ESXi host and against vCenter (https://<host>/sdk). Only these calls are used:
 * RetrieveServiceContent, Login, CreateContainerView, RetrievePropertiesEx,
 * ContinueRetrievePropertiesEx, DestroyView, Logout.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  isArray: (name) => ['objects', 'propSet', 'returnval'].includes(name),
});

export interface MoRef { type: string; value: string }

export interface VsphereObject { type: string; moid: string; props: Record<string, any> }

export class VsphereError extends Error {}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const moref = (tag: string, m: MoRef) => `<${tag} type="${m.type}">${esc(m.value)}</${tag}>`;

export class VsphereClient {
  private cookie = '';
  private apiVersion = '';
  private dispatcher: Agent;
  sc: any = null;

  constructor(private url: string, opts: { allowUntrusted?: boolean; timeoutMs?: number } = {}) {
    this.url = url.replace(/\/+$/, '').replace(/\/sdk$/, '') + '/sdk';
    this.dispatcher = new Agent({ connect: { rejectUnauthorized: !opts.allowUntrusted, timeout: opts.timeoutMs ?? 15000 }, headersTimeout: opts.timeoutMs ?? 30000, bodyTimeout: opts.timeoutMs ?? 30000 });
  }

  private async call(body: string): Promise<any> {
    const envelope = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
    const res = await request(this.url, {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: this.apiVersion ? `urn:vim25/${this.apiVersion}` : 'urn:vim25', ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: envelope,
      dispatcher: this.dispatcher,
    });
    const setCookie = res.headers['set-cookie'];
    const c = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (c && c.includes('vmware_soap_session')) this.cookie = c.split(';')[0];
    const text = await res.body.text();
    let doc: any;
    try { doc = parser.parse(text); } catch { throw new VsphereError(`ungültige Antwort (HTTP ${res.statusCode})`); }
    const bodyEl = doc?.Envelope?.Body;
    if (!bodyEl) throw new VsphereError(`keine SOAP-Antwort (HTTP ${res.statusCode}) – ist ${this.url} ein ESXi/vCenter?`);
    if (bodyEl.Fault) {
      const f = bodyEl.Fault;
      const detail = f.detail ? Object.keys(f.detail)[0] : '';
      throw new VsphereError(`${f.faultstring ?? 'SOAP-Fehler'}${detail ? ` (${detail.replace(/Fault$/, '')})` : ''}`);
    }
    return bodyEl;
  }

  async connect(username: string, password: string) {
    const b = await this.call(`<RetrieveServiceContent xmlns="urn:vim25"><_this type="ServiceInstance">ServiceInstance</_this></RetrieveServiceContent>`);
    this.sc = b.RetrieveServiceContentResponse.returnval[0];
    this.apiVersion = this.sc.about?.apiVersion ?? '';
    await this.call(`<Login xmlns="urn:vim25">${moref('_this', ref(this.sc.sessionManager))}<userName>${esc(username)}</userName><password>${esc(password)}</password></Login>`);
    return { product: this.sc.about?.fullName as string, apiVersion: this.apiVersion, apiType: this.sc.about?.apiType as string };
  }

  async logout() {
    if (!this.sc) return;
    await this.call(`<Logout xmlns="urn:vim25">${moref('_this', ref(this.sc.sessionManager))}</Logout>`).catch(() => {});
    await this.dispatcher.close().catch(() => {});
  }

  /** All objects of one managed type with the given property paths (via a container view on the root folder). */
  async list(type: string, paths: string[]): Promise<VsphereObject[]> {
    const v = await this.call(`<CreateContainerView xmlns="urn:vim25">${moref('_this', ref(this.sc.viewManager))}${moref('container', ref(this.sc.rootFolder))}<type>${type}</type><recursive>true</recursive></CreateContainerView>`);
    const view = ref(v.CreateContainerViewResponse.returnval[0]);
    try {
      const spec = `<specSet><propSet><type>${type}</type>${paths.map((p) => `<pathSet>${p}</pathSet>`).join('')}</propSet><objectSet>${moref('obj', view)}<skip>true</skip><selectSet xsi:type="TraversalSpec"><name>traverseEntities</name><type>ContainerView</type><path>view</path><skip>false</skip></selectSet></objectSet></specSet>`;
      let r = await this.call(`<RetrievePropertiesEx xmlns="urn:vim25">${moref('_this', ref(this.sc.propertyCollector))}${spec}<options><maxObjects>500</maxObjects></options></RetrievePropertiesEx>`);
      let ret = r.RetrievePropertiesExResponse?.returnval?.[0];
      const out: VsphereObject[] = [];
      while (ret) {
        out.push(...parseObjects(ret));
        if (!ret.token) break;
        r = await this.call(`<ContinueRetrievePropertiesEx xmlns="urn:vim25">${moref('_this', ref(this.sc.propertyCollector))}<token>${esc(String(ret.token))}</token></ContinueRetrievePropertiesEx>`);
        ret = r.ContinueRetrievePropertiesExResponse?.returnval?.[0];
      }
      return out;
    } finally {
      await this.call(`<DestroyView xmlns="urn:vim25">${moref('_this', view)}</DestroyView>`).catch(() => {});
    }
  }
}

function ref(x: any): MoRef {
  if (x && typeof x === 'object') return { type: x['@type'], value: String(x['#text']) };
  throw new VsphereError('unerwartete MoRef');
}

/** Normalises a parsed RetrieveResult into plain objects; MoRefs become their moid string. */
export function parseObjects(ret: any): VsphereObject[] {
  const out: VsphereObject[] = [];
  for (const o of ret.objects ?? []) {
    const props: Record<string, any> = {};
    for (const p of o.propSet ?? []) props[p.name] = simplify(p.val);
    out.push({ type: o.obj['@type'], moid: String(o.obj['#text']), props });
  }
  return out;
}

function simplify(v: any): any {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(simplify);
  const xsiType: string | undefined = v['@type'];
  // MoRef or typed scalar: <val type="HostSystem">host-1</val> / <val xsi:type="xsd:string">x</val>
  if ('#text' in v && Object.keys(v).every((k) => k === '#text' || k.startsWith('@'))) return String(v['#text']);
  // ArrayOfX: <val xsi:type="ArrayOfGuestNicInfo"><GuestNicInfo>…</GuestNicInfo></val>
  if (xsiType?.startsWith('ArrayOf')) {
    const inner = Object.entries(v).filter(([k]) => !k.startsWith('@'));
    const items = inner.flatMap(([, x]) => (Array.isArray(x) ? x : [x]));
    return items.map(simplify);
  }
  const o: Record<string, any> = {};
  for (const [k, x] of Object.entries(v)) if (!k.startsWith('@')) o[k] = simplify(x);
  if (xsiType) o._type = xsiType;
  return o;
}

export const arr = <T>(x: T | T[] | null | undefined): T[] => (x === null || x === undefined ? [] : Array.isArray(x) ? x : [x]);
