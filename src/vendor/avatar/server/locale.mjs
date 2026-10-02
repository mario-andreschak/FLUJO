export const isLocale = value => ['es', 'pt', 'en'].includes(value);
export function nativeLanguageInstruction(locale) {
  return locale === 'pt'
    ? 'Converse sempre em português do Brasil, com linguagem natural, clara e acolhedora. Não mude de idioma sem pedido explícito.'
    : locale === 'en'
      ? 'Speak natural, clear English. Keep replies brief. Do not switch languages without an explicit request.'
      : 'Conversa siempre en español latinoamericano, claro, natural y cercano, con tono colombiano neutral. No cambies de idioma sin petición explícita.';
}
