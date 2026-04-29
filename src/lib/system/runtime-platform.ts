export function getRuntimePlatform(): NodeJS.Platform {
  return Reflect.get(process, 'platform') as NodeJS.Platform;
}
