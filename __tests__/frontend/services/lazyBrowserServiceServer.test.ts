/** @jest-environment node */
import { lazyBrowserService } from '@/frontend/services/lazyBrowserService';

describe('lazyBrowserService during server rendering', () => {
  it('imports without creating anything and refuses only when the service is used', () => {
    const create = jest.fn(() => ({ ping: () => 'pong' }));
    const { service, get } = lazyBrowserService('PingService', create);
    expect(() => service.ping).toThrow('PingService can only be used in browser environment');
    expect(() => get()).toThrow('PingService can only be used in browser environment');
    expect(create).not.toHaveBeenCalled();
  });

  it('lets the model, package and registry services be imported on the server', async () => {
    const { modelService } = await import('@/frontend/services/model');
    const { packageService } = await import('@/frontend/services/packages');
    const { registryService } = await import('@/frontend/services/registry');
    expect(() => modelService.loadModels).toThrow('ModelService can only be used in browser environment');
    expect(() => packageService.resolve).toThrow('PackageService can only be used in browser environment');
    expect(() => registryService.publish).toThrow('RegistryService can only be used in browser environment');
  });
});
