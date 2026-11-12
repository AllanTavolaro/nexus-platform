import { lookup as lookupDns } from "node:dns/promises";
import ipaddr from "ipaddr.js";

export type SafeAddress = { address: string; family: number };
type AddressLookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<SafeAddress[]>;

const resolveAllAddresses: AddressLookup = (hostname, options) => lookupDns(hostname, options);

export function parseHttpTarget(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("A valid HTTP or HTTPS destination is required.");
  }

  if (!(url.protocol === "http:" || url.protocol === "https:") || url.username || url.password || !url.hostname) {
    throw new Error("Only credential-free HTTP and HTTPS destinations are allowed.");
  }
  const standardPort = url.protocol === "http:" ? "80" : "443";
  if (url.port && url.port !== standardPort) {
    throw new Error("Only standard HTTP and HTTPS ports are allowed.");
  }
  return url;
}

export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.parse(address).range() === "unicast";
  } catch {
    return false;
  }
}

export async function lookupPublicAddresses(
  hostname: string,
  lookup: AddressLookup = resolveAllAddresses,
): Promise<SafeAddress[]> {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  let addresses: SafeAddress[];
  if (ipaddr.isValid(normalized)) {
    addresses = [{ address: normalized, family: ipaddr.parse(normalized).kind() === "ipv6" ? 6 : 4 }];
  } else {
    let timeout: NodeJS.Timeout | undefined;
    try {
      addresses = await Promise.race([
        lookup(normalized, { all: true, verbatim: true }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("DNS lookup timed out.")), 4000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("The target resolves to a non-public network address.");
  }
  return addresses;
}
