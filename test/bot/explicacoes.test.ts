import { describe, expect, it } from "vitest";
import { findTopico, TOPICO_CHAVES, TOPICOS_PARA_TESTE } from "../../src/bot/commands/explicacoes.js";

/** Limite de uma mensagem de texto do Telegram. Estourar não trunca: a API
 *  rejeita a chamada inteira, e o usuário não recebe nada. */
const TELEGRAM_MAX = 4096;

describe("/explicacoes", () => {
  it("todo verbete cabe numa mensagem do Telegram", () => {
    for (const t of TOPICOS_PARA_TESTE) {
      const enviado = `${t.titulo.toUpperCase()}\n\n${t.texto}`;
      expect(enviado.length, `verbete "${t.chave}" tem ${enviado.length} chars`).toBeLessThan(TELEGRAM_MAX);
    }
  });

  it("não tem chave repetida", () => {
    expect(new Set(TOPICO_CHAVES).size).toBe(TOPICO_CHAVES.length);
  });

  // A promessa do comando é essa: fórmula + exemplo real + a ressalva. Um
  // verbete sem a ressalva vira propaganda do número.
  it("todo verbete diz o que o número NÃO diz", () => {
    for (const t of TOPICOS_PARA_TESTE) {
      expect(t.texto, `verbete "${t.chave}"`).toContain("NÃO DIZ");
    }
  });

  it("todo verbete traz um exemplo com números", () => {
    for (const t of TOPICOS_PARA_TESTE) {
      expect(t.texto, `verbete "${t.chave}"`).toMatch(/EXEMPLO|FÓRMULA/);
      expect(t.texto, `verbete "${t.chave}" sem número nenhum`).toMatch(/\d/);
    }
  });

  it("acha o verbete por prefixo e sem caso", () => {
    expect(findTopico("taxa")?.chave).toBe("taxas");
    expect(findTopico("IL")?.chave).toBe("il");
    expect(findTopico("  Faixa  ")?.chave).toBe("faixa");
  });

  it("devolve undefined em vez de chutar um verbete qualquer", () => {
    expect(findTopico("banana")).toBeUndefined();
    expect(findTopico("")).toBeUndefined();
  });
});
