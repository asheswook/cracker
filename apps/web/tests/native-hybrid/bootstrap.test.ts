import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

test('compiled actual bootstrap evaluates header graph without body/API/store/root/causal initialization', async () => {
  const source = join(import.meta.dir, '../../src');
  const output = await Bun.build({ entrypoints: [join(source, 'main.tsx')], target: 'browser',
    define: { 'import.meta.env.DEV': 'false' }, minify: false,
    plugins: [{ name: 'bootstrap-observable-boundaries', setup(build) {
      build.onLoad({ filter: /body-entry\.tsx$/ }, () => ({ contents: 'throw new Error("BODY_ENTRY_EVALUATED"); export function BodyEntry() {}', loader: 'tsx' }));
      build.onLoad({ filter: /\/(store|api|root-scroll-trial|feed-causal-trace)\.tsx?$/ }, args => ({
        contents: `throw new Error("FORBIDDEN_HEADER_INIT");\n${readFileSync(args.path, 'utf8')}`, loader: args.path.endsWith('tsx') ? 'tsx' : 'ts',
      }));
      build.onResolve({ filter: /^(react|react\/jsx(?:-dev)?-runtime|react-dom|react-dom\/client|motion\/react|lucide-react)$/ }, args => ({ path: args.path, namespace: 'mock-renderer' }));
      build.onLoad({ filter: /.*/, namespace: 'mock-renderer' }, args => {
        const modules: Record<string, string> = {
          react: 'export const useEffect=()=>{},useLayoutEffect=()=>{},useRef=()=>({}),useState=()=>[],useId=()=>"id",useMemo=()=>{},useCallback=()=>{},useSyncExternalStore=()=>{};',
          'react/jsx-dev-runtime': 'export const Fragment="fragment";export const jsxDEV=(type,props)=>({type,props});',
          'react/jsx-runtime': 'export const Fragment="fragment";export const jsx=(type,props)=>({type,props});export const jsxs=jsx;',
          'react-dom': 'export const createPortal=()=>{};',
          'react-dom/client': 'export const createRoot=()=>({render: tree=>{globalThis.__headerBootstrapResult=tree.props.children.type.name}});',
          'motion/react': 'export const LazyMotion="LazyMotion",domMax={},m={},AnimatePresence="AnimatePresence",animate=()=>{},useMotionValue=()=>{},useTransform=()=>{};',
          'lucide-react': 'export const ArrowLeft="i",ArrowDown="i",File="i",RefreshCw="i",LoaderCircle="i",ArrowUp="i",ArrowRight="i",AlertCircle="i",Monitor="i",X="i",PanelLeft="i",Clock3="i";',
        };
        return { contents: modules[args.path] ?? '', loader: 'js' };
      });
    } }],
  });
  if (!output.success) throw new AggregateError(output.logs, 'Bootstrap test bundle failed');
  const script = output.outputs.find(item => item.path.endsWith('.js'));
  if (!script) throw new Error('Missing bootstrap JS');
  const bodySource = readFileSync(join(source, 'body-entry.tsx'), 'utf8');
  expect(bodySource).toContain("import './root-scroll-trial'");

  expect(bodySource).toContain("import { App } from './App'");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, '__headerBootstrapResult');
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const execute = new AsyncFunction('window', 'document', await script.text());
  const document = { getElementById: () => ({}), documentElement: { dataset: {} } };
  try {
    await execute({ __ASSISTANT_HYBRID_ROLE__: 'header' }, document);
    expect(Reflect.get(globalThis, '__headerBootstrapResult')).toBe('HeaderOnly');
    expect(document.documentElement.dataset).toEqual({ headerOnly: 'true' });
    await execute({ __ASSISTANT_HYBRID_ROLE__: 'footer' }, document);
    expect(Reflect.get(globalThis, '__headerBootstrapResult')).toBe('FooterOnly');
    await expect(execute({}, document)).rejects.toThrow('BODY_ENTRY_EVALUATED');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, '__headerBootstrapResult', descriptor);
    else Reflect.deleteProperty(globalThis, '__headerBootstrapResult');
  }
});
