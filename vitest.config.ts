import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Testes de integração compartilham um único Postgres e isolam entre si
    // via TRUNCATE (não schemas/transactions por teste) — rodar arquivos em
    // paralelo causa corrida de dados entre eles (um beforeEach truncando
    // no meio de outro teste) e pode até deadlockar no TRUNCATE CASCADE
    // concorrente. Sequencial evita os dois problemas; o custo é aceitável
    // pro tamanho da suíte atual.
    fileParallelism: false,
    env: {
      // Testes de integração (repositórios, jobs) tocam o banco de verdade —
      // isolados num banco separado (poolsbot_test) pra nunca arriscar dado
      // de dev/produção local. dotenv não sobrescreve valores já setados em
      // process.env, então isso tem prioridade sobre o DATABASE_URL do .env.
      DATABASE_URL: "postgres://poolsbot:poolsbot@localhost:5433/poolsbot_test",
    },
  },
});
