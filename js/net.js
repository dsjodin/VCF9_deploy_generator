// IPv4/IPv6/FQDN helpers used by validation and JSON builders.
(function () {
  const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  const LABEL = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

  function isIPv4(s) { return typeof s === 'string' && IPV4.test(s); }

  function isIPv6(s) {
    if (typeof s !== 'string' || s.indexOf(':') < 0) return false;
    try { new URL('http://[' + s + ']'); return true; } catch (e) { return false; }
  }

  function toInt(ip) {
    return ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
  }

  function toIp(n) {
    return [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255].join('.');
  }

  function prefixToMask(p) {
    return toIp(p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0);
  }

  function maskToPrefix(m) {
    if (!isIPv4(m)) return null;
    const n = toInt(m);
    const bits = n.toString(2).padStart(32, '0');
    if (!/^1*0*$/.test(bits)) return null;
    return bits.indexOf('0') < 0 ? 32 : bits.indexOf('0');
  }

  // "10.0.0.1/24" -> {ip, prefix, network, mask, first, last, broadcast}
  function parseCidr(s) {
    if (typeof s !== 'string') return null;
    const m = s.trim().match(/^([\d.]+)\/(\d{1,2})$/);
    if (!m || !isIPv4(m[1]) || Number(m[2]) > 32) return null;
    const prefix = Number(m[2]);
    const ipn = toInt(m[1]);
    const size = Math.pow(2, 32 - prefix);
    const net = ipn - (ipn % size);
    return {
      ip: m[1], prefix, mask: prefixToMask(prefix), size,
      network: toIp(net), networkInt: net, broadcastInt: net + size - 1,
      cidr: toIp(net) + '/' + prefix,
    };
  }

  function isCidr(s) { return !!parseCidr(s); }

  function isNetworkCidr(s) {
    const c = parseCidr(s);
    return !!c && c.ip === c.network;
  }

  function isIPv6Cidr(s) {
    if (typeof s !== 'string') return false;
    const m = s.trim().match(/^(.+)\/(\d{1,3})$/);
    return !!m && isIPv6(m[1]) && Number(m[2]) <= 128;
  }

  function inSubnet(ip, cidr) {
    const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
    if (!c || !isIPv4(ip)) return false;
    const n = toInt(ip);
    return n >= c.networkInt && n <= c.broadcastInt;
  }

  function isUsableHost(ip, cidr) {
    const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
    if (!inSubnet(ip, c)) return false;
    if (c.prefix >= 31) return true;
    const n = toInt(ip);
    return n !== c.networkInt && n !== c.broadcastInt;
  }

  function rangeCount(start, end) {
    if (!isIPv4(start) || !isIPv4(end)) return 0;
    return toInt(end) - toInt(start) + 1;
  }

  function rangesOverlap(a1, a2, b1, b2) {
    return toInt(a1) <= toInt(b2) && toInt(b1) <= toInt(a2);
  }

  function cidrsOverlap(a, b) {
    const x = parseCidr(a), y = parseCidr(b);
    if (!x || !y) return false;
    return x.networkInt <= y.broadcastInt && y.networkInt <= x.broadcastInt;
  }

  function expandRange(start, end, max) {
    const out = [];
    if (!isIPv4(start) || !isIPv4(end)) return out;
    for (let n = toInt(start); n <= toInt(end) && out.length < (max || 256); n++) out.push(toIp(n));
    return out;
  }

  function isFqdn(s) {
    if (typeof s !== 'string' || s.length > 253 || s.indexOf('.') < 0) return false;
    const parts = s.replace(/\.$/, '').split('.');
    return parts.every(p => LABEL.test(p)) && !/^\d+$/.test(parts[parts.length - 1]);
  }

  function isHostLabel(s) { return typeof s === 'string' && LABEL.test(s); }

  function isDomain(s) {
    return typeof s === 'string' && s.replace(/\.$/, '').split('.').every(p => LABEL.test(p));
  }

  function shortName(fqdn) { return (fqdn || '').split('.')[0]; }

  function domainOf(fqdn) { return (fqdn || '').split('.').slice(1).join('.'); }

  window.Net = {
    isIPv4, isIPv6, toInt, toIp, prefixToMask, maskToPrefix, parseCidr, isCidr, isNetworkCidr,
    isIPv6Cidr, inSubnet, isUsableHost, rangeCount, rangesOverlap, cidrsOverlap, expandRange,
    isFqdn, isHostLabel, isDomain, shortName, domainOf,
  };
})();
