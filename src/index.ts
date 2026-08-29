import { main } from './main.ts';

main().catch((e: any) => {
  console.error(e);
  process.exit(1);
});
