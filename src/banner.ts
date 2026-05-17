const ART = String.raw`
 ██████╗ ██████╗ ███╗   ██╗████████╗███████╗██╗  ██╗████████╗██████╗ ███████╗██████╗  ██████╗
██╔════╝██╔═══██╗████╗  ██║╚══██╔══╝██╔════╝╚██╗██╔╝╚══██╔══╝██╔══██╗██╔════╝██╔══██╗██╔════╝
██║     ██║   ██║██╔██╗ ██║   ██║   █████╗   ╚███╔╝    ██║   ██████╔╝█████╗  ██████╔╝██║  ███╗
██║     ██║   ██║██║╚██╗██║   ██║   ██╔══╝   ██╔██╗    ██║   ██╔══██╗██╔══╝  ██╔══██╗██║   ██║
╚██████╗╚██████╔╝██║ ╚████║   ██║   ███████╗██╔╝ ██╗   ██║   ██████╔╝███████╗██║  ██║╚██████╔╝
 ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚═════╝
`;

export function printBanner(): void {
  const useColor = process.stdout.isTTY && process.env['NO_COLOR'] === undefined;
  const cyan = useColor ? '\x1b[36m' : '';
  const dim = useColor ? '\x1b[2m' : '';
  const reset = useColor ? '\x1b[0m' : '';
  process.stdout.write(`${cyan}${ART}${reset}\n`);
  process.stdout.write(`${dim}  Browse AI coding agent transcripts — https://contextberg.com${reset}\n\n`);
}
