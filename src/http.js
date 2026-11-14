// Ajudas para as rotas que recebem dados (POST) do navegador.

// So aceitamos JSON. Alem de simplificar, isso impede que uma pagina de outro site, aberta no
// mesmo navegador, mande comandos para o servidor local: o navegador so deixa outra origem
// enviar esse tipo de conteudo com uma autorizacao que este servidor nunca da.
export const isJson = (req) => String(req.headers['content-type'] || '').startsWith('application/json');

export function readJson(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) { reject(new Error('corpo grande demais')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('JSON invalido')); }
    });
    req.on('error', reject);
  });
}
