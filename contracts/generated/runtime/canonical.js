import { createHash } from "node:crypto";
export function compareCodeUnits(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function canonicalValue(value) {
    if (Array.isArray(value))
        return value.map(canonicalValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .sort(([left], [right]) => compareCodeUnits(left, right))
            .map(([key, child]) => [key, canonicalValue(child)]));
    }
    return value;
}
export function canonicalJson(value) {
    return JSON.stringify(canonicalValue(value));
}
export function canonicalBytes(value) {
    return Buffer.from(canonicalJson(value), "utf8");
}
export function digestNormalized(normalized) {
    return createHash("sha256").update(normalized).digest("hex");
}
export function digestCanonicalJson(value) {
    return digestNormalized(canonicalJson(value));
}
