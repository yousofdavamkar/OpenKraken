// The English catalog defines the keys required in every translation.
const en = {
  welcomeTitle: 'A clear view of your history.',
  welcomeDescription:
    'Explore branches, inspect your working tree, and follow the commits that brought you here.',
  startChoice: 'How would you like to start?',
  openChoice: 'Open a folder',
  cloneChoice: 'Clone a remote',
  initChoice: 'Start a new repository',
  openHelp: 'Choose a folder that already contains a Git repository.',
  cloneHelp:
    'Enter a repository URL or browse a connected provider, then choose an empty local folder.',
  initHelp: 'Choose an initial branch name and a local folder for the new repository.',
  cloneRepository: 'Clone a repository',
  initRepository: 'Initialize a repository',
  skipGuide: 'Skip guide',
  replayGuide: 'Getting started',
  openRepository: 'Open a repository',
  localGit: 'Uses Git installed on your computer · No account required',
};
const es = {
  welcomeTitle: 'Explora el historial de tu repositorio.',
  welcomeDescription:
    'Explora las ramas, revisa tu árbol de trabajo y sigue el historial de commits.',
  startChoice: '¿Cómo quieres empezar?',
  openChoice: 'Abrir una carpeta',
  cloneChoice: 'Clonar un repositorio remoto',
  initChoice: 'Crear un repositorio',
  openHelp: 'Elige una carpeta que ya contenga un repositorio Git.',
  cloneHelp:
    'Introduce la URL del repositorio o elige uno de un proveedor conectado. Después, selecciona una carpeta local vacía.',
  initHelp: 'Elige el nombre de la rama inicial y una carpeta local para el nuevo repositorio.',
  cloneRepository: 'Clonar un repositorio',
  initRepository: 'Inicializar un repositorio',
  skipGuide: 'Omitir la guía',
  replayGuide: 'Primeros pasos',
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
