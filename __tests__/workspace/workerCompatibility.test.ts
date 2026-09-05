import applicationPackage from '../../package.json';
import { getWorkerCompatibility } from '@/backend/services/workspace/workerCompatibility';

describe('worker image compatibility metadata', () => {
  const originalRevision = process.env.FLUJO_BUILD_REVISION;

  afterEach(() => {
    if (originalRevision === undefined) delete process.env.FLUJO_BUILD_REVISION;
    else process.env.FLUJO_BUILD_REVISION = originalRevision;
  });

  it('reports the implemented contract without claiming a checkout/build revision', () => {
    delete process.env.FLUJO_BUILD_REVISION;
    expect(getWorkerCompatibility()).toEqual({
      applicationVersion: applicationPackage.version,
      snapshotFormatVersion: 2,
      layoutVersion: 2,
      workerProtocolVersion: 1,
    });
  });

  it('includes an explicit full build revision', () => {
    process.env.FLUJO_BUILD_REVISION = 'a'.repeat(40);
    expect(getWorkerCompatibility()).toMatchObject({ revision: 'a'.repeat(40) });
  });

  it.each(['abc1234', 'main', 'a'.repeat(39), 'a'.repeat(41), '../private', 'sensitive invalid value']) (
    'omits malformed build revision metadata (%s)', (revision) => {
      process.env.FLUJO_BUILD_REVISION = revision;
      expect(getWorkerCompatibility()).not.toHaveProperty('revision');
    },
  );
});
