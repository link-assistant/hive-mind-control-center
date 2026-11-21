// macOS netstat -anv prints numeric foreign endpoints as address.port.
export function proxySocketRows(output, address, port) {
  const endpoint = `${address}.${port}`;
  return output.split(/\r?\n/).filter((line) => {
    const [protocol, , , , foreign] = line.trim().split(/\s+/, 5);
    return protocol.startsWith('tcp') && foreign === endpoint;
  });
}
