// Le o arquivo .env da raiz do projeto para as variaveis de ambiente. Tem que ser o PRIMEIRO
// modulo carregado (ver src/index.js), antes de a configuracao ser lida.
//
// E nesse arquivo, que o git ignora, que ficam as chaves do Demo Mode. Uma variavel ja definida
// no terminal vale mais que a do arquivo.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));

export const envFileFound = existsSync(ENV_FILE);
export let envFileError = null;
if (envFileFound) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (err) {
    envFileError = `nao foi possivel ler o arquivo .env (${err.code ?? err.name})`; // sem o conteudo do arquivo
  }
}

// As chaves do Demo Mode, ou null se faltam. Quem recebe nunca as escreve em log nem na tela.
export function demoKeys() {
  const apiKey = (process.env.BINANCE_DEMO_KEY || '').trim();
  const apiSecret = (process.env.BINANCE_DEMO_SECRET || '').trim();
  return apiKey && apiSecret ? { apiKey, apiSecret } : null;
}
