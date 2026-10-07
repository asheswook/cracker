import './root-scroll-trial';
import { App } from './App';
import { Showcase } from './primitives';
import { ErrorToasts } from './ErrorToasts';
export function BodyEntry() {
  return <>{import.meta.env.DEV && new URLSearchParams(location.search).has('showcase') ? <Showcase /> : <App />}<ErrorToasts /></>;
}
