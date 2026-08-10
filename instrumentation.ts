export async function register() {
  if (process.env.NODE_ENV === 'development') {
    const { ProxyAgent, setGlobalDispatcher } = await import('undici')
    setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:7890'))
  }
}
