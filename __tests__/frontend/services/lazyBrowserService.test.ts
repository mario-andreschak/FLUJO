/** @jest-environment jsdom */
import { lazyBrowserService } from '@/frontend/services/lazyBrowserService';

class Counter {
  label = 'counter';
  #count = 0;
  get doubled() { return this.#count * 2; }
  increment() { this.#count += 1; return this.#count; }
}

describe('lazyBrowserService', () => {
  it('creates nothing until a property is first read, then reuses one instance', () => {
    const create = jest.fn(() => new Counter());
    const lazy = lazyBrowserService('Counter', create);
    expect(create).not.toHaveBeenCalled();

    expect(lazy.service.label).toBe('counter');
    expect(create).toHaveBeenCalledTimes(1);

    lazy.service.increment();
    expect(lazy.get()).toBe(lazy.get());
    expect(lazy.get().doubled).toBe(2);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('keeps `this` for methods and getters, even when a method is detached', () => {
    const { service, get } = lazyBrowserService('Counter', () => new Counter());
    const { increment } = service;
    expect(increment()).toBe(1);
    expect(service.increment()).toBe(2);
    expect(service.doubled).toBe(4);
    expect(get().doubled).toBe(4);
  });

  it('passes plain values through unchanged', () => {
    const settings = { name: 'registry', retries: 3, nested: { on: true }, missing: undefined as string | undefined };
    const { service } = lazyBrowserService('Settings', () => settings);
    expect(service.name).toBe('registry');
    expect(service.retries).toBe(3);
    expect(service.nested).toBe(settings.nested);
    expect(service.missing).toBeUndefined();
  });

  it('backs the model, package and registry services with one instance each', async () => {
    const { modelService, getModelService } = await import('@/frontend/services/model');
    const { packageService, getPackageService } = await import('@/frontend/services/packages');
    const { registryService, getRegistryService } = await import('@/frontend/services/registry');

    expect(getModelService()).toBe(getModelService());
    expect(getPackageService()).toBe(getPackageService());
    expect(getRegistryService()).toBe(getRegistryService());
    expect(modelService.loadModels).toEqual(expect.any(Function));
    expect(packageService.resolve).toEqual(expect.any(Function));
    expect(registryService.publish).toEqual(expect.any(Function));
  });
});
