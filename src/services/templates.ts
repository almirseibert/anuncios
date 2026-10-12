import { config } from '../config.ts';
import { formatBRL, isOwnPhoto, kmFormat, type Product } from '../domain/product.ts';

const FUEL: Record<string, string> = {
  flex: 'Flex', gasolina: 'Gasolina', etanol: 'Etanol', diesel: 'Diesel',
  gnv: 'GNV', eletrico: 'Eletrico', hibrido: 'Hibrido',
};
const TRANS: Record<string, string> = {
  manual: 'Manual', automatico: 'Automatico', automatizado: 'Automatizado', cvt: 'CVT',
};
const WEAR: Record<string, string> = {
  novo: 'Novo, sem uso', seminovo: 'Semi-novo', bom: 'Em bom estado',
  usado_marcas: 'Usado, com marcas de uso', para_reparo: 'Para reparo / pecas',
};
const OPERATION: Record<string, string> = { venda: 'Venda', aluguel: 'Aluguel', temporada: 'Temporada' };

/** Linhas "Campo: valor" derivadas dos atributos do tipo de produto. */
export function specLines(p: Product): string[] {
  const a = p.attrs as Record<string, unknown>;
  const lines: string[] = [];
  const push = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === '' || value === 0) return;
    lines.push(`${label}: ${String(value)}`);
  };

  if (p.kind === 'veiculo') {
    push('Marca', a.brand);
    push('Modelo', [a.model, a.version].filter(Boolean).join(' '));
    if (a.yearManufacture && a.yearModel) lines.push(`Ano: ${a.yearManufacture}/${a.yearModel}`);
    if (typeof a.km === 'number') lines.push(`Quilometragem: ${kmFormat(a.km)}`);
    push('Combustivel', FUEL[String(a.fuel)] ?? a.fuel);
    push('Cambio', TRANS[String(a.transmission)] ?? a.transmission);
    push('Cor', a.color);
    push('Portas', a.doors);
    push('Final da placa', a.plateEnd);
    if (a.licensed) lines.push('Licenciado e sem debitos');
    if (a.singleOwner) lines.push('Unico dono');
    if (Array.isArray(a.features) && a.features.length) lines.push(`Opcionais: ${a.features.join(', ')}`);
  }

  if (p.kind === 'imovel') {
    push('Operacao', OPERATION[String(a.operation)] ?? a.operation);
    push('Tipo', a.propertyType);
    if (a.usableAreaM2) lines.push(`Area util: ${a.usableAreaM2} m2`);
    if (a.totalAreaM2) lines.push(`Area total: ${a.totalAreaM2} m2`);
    push('Quartos', a.bedrooms);
    push('Suites', a.suites);
    push('Banheiros', a.bathrooms);
    push('Vagas', a.parkingSpots);
    if (a.condoFeeCents) lines.push(`Condominio: ${formatBRL(a.condoFeeCents as number)}`);
    if (a.iptuCents) lines.push(`IPTU: ${formatBRL(a.iptuCents as number)}`);
    if (a.furnished) lines.push('Mobiliado');
    if (Array.isArray(a.features) && a.features.length) lines.push(`Diferenciais: ${a.features.join(', ')}`);
  }

  if (p.kind === 'geral') {
    push('Marca', a.brand);
    push('Modelo', a.model);
    push('Estado', WEAR[String(a.wear)] ?? a.wear);
    push('Garantia', a.warranty);
  }

  return lines;
}

export function locationLine(p: Product) {
  const city = p.city || config.seller.city;
  const uf = p.uf || config.seller.uf;
  return [p.neighborhood, city, uf].filter(Boolean).join(' - ');
}

/**
 * Aviso obrigatorio quando a galeria tem foto que nao e do item real: o
 * comprador tem de saber qual foto e o produto dele e qual ilustra o modelo.
 * E o que separa "foto de catalogo como referencia" de anuncio enganoso.
 */
export function illustrativeNote(p: Product): string | undefined {
  const own = p.images.filter(isOwnPhoto).length;
  const ilustrativas = p.images.length - own;
  if (ilustrativas === 0) return undefined;
  const quantas = ilustrativas === 1 ? 'A ultima foto e ilustrativa' : `As ${ilustrativas} ultimas fotos sao ilustrativas`;
  return `${quantas} do modelo, para mostrar os detalhes de fabrica. ${
    own === 1 ? 'A primeira foto e' : `As ${own} primeiras fotos sao`
  } do item real, como ele esta hoje.`;
}

/** Descricao longa usada nos canais com API (ML, OLX, catalogo Meta). */
export function buildDescription(p: Product): string {
  const parts = [p.description.trim()];
  const specs = specLines(p);
  if (specs.length) parts.push(`DETALHES\n${specs.map((l) => `- ${l}`).join('\n')}`);
  const loc = locationLine(p);
  if (loc) parts.push(`LOCALIZACAO\n${loc}`);
  if (p.acceptsTrade) parts.push('Aceito troca.');
  const nota = illustrativeNote(p);
  if (nota) parts.push(`SOBRE AS FOTOS\n${nota}`);
  return parts.filter(Boolean).join('\n\n').slice(0, 7000);
}

/** Post pronto para colar em grupo de venda do Facebook. */
export function buildGroupPost(p: Product): string {
  const specs = specLines(p);
  const loc = locationLine(p);
  const lines = [
    `${p.title.toUpperCase()}`,
    `Valor: ${formatBRL(p.priceCents)}${p.kind === 'imovel' && (p.attrs as Record<string, unknown>).operation === 'aluguel' ? '/mes' : ''}`,
    '',
    p.description.trim(),
  ];
  if (specs.length) lines.push('', ...specs.map((l) => `- ${l}`));
  if (loc) lines.push('', `Local: ${loc}`);
  if (p.acceptsTrade) lines.push('Aceito troca.');
  const nota = illustrativeNote(p);
  if (nota) lines.push('', nota);
  const contact = [config.seller.name, config.seller.phone].filter(Boolean).join(' - ');
  if (contact) lines.push('', `Contato: ${contact}`);
  lines.push('', hashtags(p).join(' '));
  return lines.filter((l) => l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Mensagem curta para WhatsApp / status. */
export function buildWhatsappPitch(p: Product): string {
  const loc = locationLine(p);
  return [
    `*${p.title}* - ${formatBRL(p.priceCents)}`,
    specLines(p).slice(0, 5).join(' | '),
    loc && `Local: ${loc}`,
    'Tenho fotos, posso enviar.',
  ].filter(Boolean).join('\n');
}

export function hashtags(p: Product): string[] {
  const tags = new Set<string>();
  const a = p.attrs as Record<string, unknown>;
  const add = (v: unknown) => {
    const slug = String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    if (slug.length > 2) tags.add(`#${slug}`);
  };
  if (p.kind === 'veiculo') { add(a.brand); add(a.model); add(a.yearModel); add('carrousado'); }
  if (p.kind === 'imovel') { add(a.propertyType); add(a.operation); add('imovel'); }
  if (p.kind === 'geral') { add(a.brand); add('usado'); add('desapego'); }
  add(p.city || config.seller.city);
  return [...tags].slice(0, 8);
}
