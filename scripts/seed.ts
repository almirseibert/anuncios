/**
 * Cria um produto de exemplo de cada tipo, para conhecer o fluxo sem digitar nada.
 * Uso: npm run seed
 */
import { productInput } from '../src/domain/product.ts';
import { createProduct, listProducts } from '../src/services/products.ts';

const exemplos = [
  {
    kind: 'geral' as const,
    title: 'Sofa retratil 3 lugares suede cinza',
    description: 'Usado por 2 anos, sem rasgos nem manchas. Retirada no local.',
    priceCents: 89000,
    condition: 'usado' as const,
    quantity: 1,
    acceptsTrade: false,
    cep: '89010-000', city: 'Blumenau', uf: 'SC', neighborhood: 'Centro',
    attrs: { brand: 'Estofados Jardim', model: 'Retratil 3L', wear: 'bom', warranty: '' },
  },
  {
    kind: 'veiculo' as const,
    title: 'Honda Civic EXL 2.0 2018 automatico',
    description: 'Segundo dono, revisoes na concessionaria, pneus novos.',
    priceCents: 10900000,
    condition: 'usado' as const,
    quantity: 1,
    acceptsTrade: true,
    cep: '89010-000', city: 'Blumenau', uf: 'SC', neighborhood: 'Velha',
    attrs: {
      vehicleType: 'carro', brand: 'Honda', model: 'Civic', version: 'EXL 2.0',
      yearManufacture: 2018, yearModel: 2018, km: 72000, fuel: 'flex', transmission: 'cvt',
      color: 'Branco', doors: 4, plateEnd: '3', licensed: true, singleOwner: false,
      features: ['Couro', 'Teto solar', 'Multimidia'],
    },
  },
  {
    kind: 'imovel' as const,
    title: 'Apartamento 2 quartos com vaga no Centro',
    description: 'Andar alto, sol da manha, predio com elevador e portaria.',
    priceCents: 38000000,
    condition: 'usado' as const,
    quantity: 1,
    acceptsTrade: false,
    cep: '89010-000', city: 'Blumenau', uf: 'SC', neighborhood: 'Centro',
    attrs: {
      operation: 'venda', propertyType: 'apartamento', usableAreaM2: 68, totalAreaM2: 78,
      bedrooms: 2, suites: 1, bathrooms: 2, parkingSpots: 1,
      condoFeeCents: 45000, iptuCents: 120000, furnished: false,
      features: ['Elevador', 'Portaria 24h', 'Sacada'],
    },
  },
];

const existentes = new Set(listProducts({ includeArchived: true }).map((p) => p.title));

for (const exemplo of exemplos) {
  if (existentes.has(exemplo.title)) {
    console.log(`ja existe: ${exemplo.title}`);
    continue;
  }
  const parsed = productInput.parse(exemplo);
  const product = createProduct(parsed);
  console.log(`criado ${product.kind.padEnd(8)} ${product.id}  ${product.title}`);
}

console.log('\nAbra http://127.0.0.1:3000 e envie fotos antes de publicar.');
