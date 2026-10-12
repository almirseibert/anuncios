import { xmlEscape as e } from '../../lib/http.ts';
import { buildDescription } from '../../services/templates.ts';
import { config } from '../../config.ts';
import type { Product } from '../../domain/product.ts';

/**
 * Gera o XML de autoupload da OLX.
 *
 * ATENCAO: a OLX entrega o schema definitivo (nomes de campos, categorias e
 * enums) junto com a aprovacao da integracao, e ele muda por vertical
 * (imoveis / autos / produtos). O layout abaixo segue a estrutura publicada
 * do autoupload e e o ponto unico a ajustar quando voce receber o manual:
 * nada fora deste arquivo depende do formato.
 */
export function buildOlxAd(product: Product): string {
  const a = product.attrs as Record<string, unknown>;
  const rows: string[] = [
    `<id>${e(product.id)}</id>`,
    `<subject>${e(product.title.slice(0, 90))}</subject>`,
    `<body>${e(buildDescription(product))}</body>`,
    `<price>${Math.round(product.priceCents / 100)}</price>`,
    `<category>${e(categoryFor(product))}</category>`,
    `<zipcode>${e((product.cep || config.seller.cep).replace(/\D/g, ''))}</zipcode>`,
  ];
  if (product.city) rows.push(`<city>${e(product.city)}</city>`);
  if (product.uf) rows.push(`<state>${e(product.uf)}</state>`);
  if (product.neighborhood) rows.push(`<neighborhood>${e(product.neighborhood)}</neighborhood>`);

  if (product.kind === 'veiculo') {
    rows.push(
      `<vehicle_brand>${e(a.brand)}</vehicle_brand>`,
      `<vehicle_model>${e(a.model)}</vehicle_model>`,
      `<vehicle_version>${e(a.version)}</vehicle_version>`,
      `<regdate>${e(a.yearModel)}</regdate>`,
      `<mileage>${e(a.km)}</mileage>`,
      `<fuel>${e(a.fuel)}</fuel>`,
      `<gearbox>${e(a.transmission)}</gearbox>`,
      `<doors>${e(a.doors)}</doors>`,
      `<color>${e(a.color)}</color>`,
    );
  }
  if (product.kind === 'imovel') {
    rows.push(
      `<property_type>${e(a.propertyType)}</property_type>`,
      `<operation>${e(a.operation)}</operation>`,
      `<size>${e(a.usableAreaM2)}</size>`,
      `<rooms>${e(a.bedrooms)}</rooms>`,
      `<bathrooms>${e(a.bathrooms)}</bathrooms>`,
      `<garage_spaces>${e(a.parkingSpots)}</garage_spaces>`,
      `<condominium>${Math.round(((a.condoFeeCents as unknown as number) ?? 0) / 100)}</condominium>`,
      `<iptu>${Math.round(((a.iptuCents as unknown as number) ?? 0) / 100)}</iptu>`,
    );
  }

  const images = product.images.map((i) => `      <image_url>${e(i.url)}</image_url>`).join('\n');
  return [
    '  <ad>',
    ...rows.map((r) => `    ${r}`),
    '    <images>',
    images,
    '    </images>',
    '  </ad>',
  ].filter((l) => l.trim() !== '').join('\n');
}

function categoryFor(product: Product) {
  if (product.kind === 'veiculo') return 'auto';
  if (product.kind === 'imovel') return 'imovel';
  return 'produto';
}

export function buildOlxFeed(products: Product[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ads>',
    ...products.map(buildOlxAd),
    '</ads>',
    '',
  ].join('\n');
}
