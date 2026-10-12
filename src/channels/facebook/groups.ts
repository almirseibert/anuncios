import type { Product } from '../../domain/product.ts';
import { buildGroupPost } from '../../services/templates.ts';
import type { Channel, PublishContext, PublishResult, ValidationIssue } from '../types.ts';

export const CHANNEL_ID = 'facebook_grupos';

/**
 * Canal manual por decisao de projeto, nao por falta de implementacao.
 *
 * A Meta removeu a publicacao programatica em grupos (a permissao
 * publish_to_groups foi descontinuada em 2020) e automatizar o navegador
 * logado viola os Termos da plataforma e e o caminho mais rapido para a conta
 * ser bloqueada. O sistema entrega o conteudo pronto e voce cola.
 */
function validate(product: Product): ValidationIssue[] {
  const issues: ValidationIssue[] = [
    {
      severity: 'warn',
      message: 'Grupos do Facebook nao tem API: o sistema gera o texto e as fotos, a postagem e feita por voce.',
    },
  ];
  if (product.images.length === 0) {
    issues.push({ field: 'images', severity: 'warn', message: 'posts com foto tem muito mais alcance nos grupos' });
  }
  return issues;
}

async function publish(ctx: PublishContext): Promise<PublishResult> {
  const text = buildGroupPost(ctx.product);
  return {
    status: 'rascunho',
    payload: { text },
    manualKit: {
      headline: ctx.product.title,
      text,
      imageUrls: ctx.product.images.map((i) => i.url),
      steps: [
        'Abra o grupo de vendas da sua regiao no Facebook.',
        'Clique em "Vender algo" ou "Criar publicacao".',
        'Cole o texto copiado abaixo.',
        'Anexe as fotos (use "Baixar todas" para pegar os arquivos).',
        'Publique e marque o anuncio como publicado aqui no painel.',
      ],
    },
    message: 'kit de publicacao gerado: copie o texto e cole no grupo',
  };
}

export const facebookGroups: Channel = {
  id: CHANNEL_ID,
  label: 'Grupos do Facebook (manual)',
  mode: 'manual',
  kinds: ['geral', 'veiculo', 'imovel'],
  docsUrl: 'https://developers.facebook.com/docs/graph-api/changelog/breaking-changes',
  requiredEnv: [],
  isConfigured: () => true,
  validate,
  publish,
};
