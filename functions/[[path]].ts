import { handleApi } from '../worker/api';
import type { Env } from '../worker/types';

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  if (url.pathname.startsWith('/api/')) {
    return handleApi(context.request, context.env);
  }
  return context.env.ASSETS.fetch(context.request);
};
