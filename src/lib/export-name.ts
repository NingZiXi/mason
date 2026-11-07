const invalidCharacters = /[<>:"/\\|?*\u0000-\u001f]/;
const reservedName = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i;

export function validExportName(value: string): boolean {
  return !!value && value === value.trim() && !invalidCharacters.test(value)
    && !value.endsWith('.') && !reservedName.test(value)
    && new TextEncoder().encode(value).length <= 200;
}

export function defaultExportName(filename: string | null | undefined): string {
  let name = (filename?.split(/[\\/]/).pop() ?? '').replace(/\.[^.]+$/, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim().replace(/[. ]+$/, '');
  while (new TextEncoder().encode(name).length > 200) name = Array.from(name).slice(0, -1).join('');
  name = name.trim().replace(/[. ]+$/, '');
  return validExportName(name) ? name : 'Mason';
}
