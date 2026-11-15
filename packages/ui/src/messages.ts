// The English catalog defines the keys required in every translation.
const en = {
  welcomeTitle: 'A clear view of your history.',
  welcomeDescription:
    'Explore branches, inspect your working tree, and follow the commits that brought you here.',
  openRepository: 'Open a repository',
  localGit: 'Uses Git installed on your computer · No account required',
};
const es = {
  welcomeTitle: 'Explora el historial de tu repositorio.',
  welcomeDescription:
    'Explora las ramas, revisa tu árbol de trabajo y sigue el historial de commits.',
  openRepository: 'Abrir un repositorio',
  localGit: 'Usa el Git instalado en tu equipo · No necesitas una cuenta',
} satisfies Record<keyof typeof en, string>;

const catalogs = { en: { language: 'en', messages: en }, es: { language: 'es', messages: es } };
export function messagesFor(languages: readonly string[]) {
  for (const tag of languages) {
    try {
      const language = new Intl.Locale(tag).language;
      if (language === 'en' || language === 'es') return catalogs[language];
    } catch {
      // Continue with the next preferred language if a tag is malformed.
    }
  }
  return catalogs.en;
}
