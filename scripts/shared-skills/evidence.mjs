import os from 'node:os';
import {root} from './check.mjs';

export function redactEvidence(value) {
  const replacements = [[root, '<REPOSITORY>'], [os.homedir(), '<USER_HOME>']];
  const redact = text => {
    for (const [source, replacement] of replacements) {
      text = text.replaceAll(source.replaceAll('\\', '\\\\'), replacement)
        .replaceAll(source, replacement).replaceAll(source.replaceAll('\\', '/'), replacement);
    }
    return text;
  };
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactEvidence);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,redactEvidence(item)]));
  return value;
}
