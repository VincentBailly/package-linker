import * as path from "path";
import * as fs from "fs";
import * as child_process from "child_process";

const realpath = (p: string): Promise<string> => {
  return new Promise(resolve => {
    try {
      fs.realpath(p, (err, value) => {
        if (err) { resolve("") }
        else { resolve(value) }
      })
    } catch (e) { resolve("") }
  })
}

const symlink = (existingFile: string, newFile: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    try {
      fs.symlink(existingFile, newFile, (err) => {
        if (err) { reject(err) }
        else { resolve() }
      })
    } catch (e) { reject(e) }
  })
}

const copyFile = (source: string, target: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    try {
      fs.copyFile(source, target, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

const stat = (p: string): Promise<fs.Stats> => {
  return new Promise((resolve, reject) => {
    try {
      fs.stat(p, (err, value) => {
        if (err) {
          reject(err);
        } else {
          resolve(value);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

const readdir = (p: string): Promise<string[]> => {
  return new Promise((resolve, reject) => {
    try {
      fs.readdir(p, (err, value) => {
        if (err) {
          reject(err);
        } else {
          resolve(value);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

const rmdir = (p: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    try {
      fs.rmdir(p, { recursive: true }, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

const mkdir = (p: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    try {
      fs.mkdir(p, { recursive: true }, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

type HashFile = { node: string, hash: string }[];
type GraphFile = { nodes: string[], links: { source: string, target: string }[] };
type MapFile = { name: string, version: string, location: string }[];

const hashFile: HashFile = require(path.join(process.cwd(), "hash.json"));
const graphFile: GraphFile = require(path.join(process.cwd(), "resolved_graph.json"));
const mapFile: MapFile = require(path.join(process.cwd(), "map.json"));

const nodes = graphFile.nodes;

type HashMap = Map<string, string>;
const hashMap: HashMap = new Map(hashFile.map(o => [o.node, o.hash]));

type LinksMap = Map<string, string[]>;
const linksMap: LinksMap = new Map(graphFile.nodes.map(n => [n, graphFile.links.filter(l => l.source === n).map(l => l.target)]))

type LocationMap = Map<string, string>;
const locationMap: LocationMap = new Map(mapFile.map(o => [`${o.name}@${o.version}`, o.location]));

fs.rmdirSync(".package_store", { recursive: true });
fs.mkdirSync(".package_store", { recursive: true });

async function getFiles(p: string): Promise<string[]> {
  const dir = await readdir(p);
  const files = await Promise.all(dir.map(async f => {
    const st = await stat(path.join(p, f));
    if (st.isDirectory()) {
      const files = await getFiles(path.join(p, f));
      return files.map(ff => path.join(f, ff));
    } else {
      return [f];
    }
  }));
  const result = files.reduce((p, n) => [...p, ...n], []);
  return result;
}

async function copyDir(source: string, destination: string): Promise<void> {
  const files = await getFiles(source);
  //await writeFile(path.join(".package_store", hashMap.get(n).replace(/\//g, "_"), "toCopy.txt"), files.join("\n"));

  await Promise.all(files.map(async f => {
    if (path.basename(f).startsWith(".yarn-")) {
      return;
    }
    await mkdir(path.dirname(path.join(destination, f)));
    await copyFile(path.join(source, f), path.join(destination, f))
  })); 
}

async function getInstallLocation(cacheLocation: string, name: string) {
  if (cacheLocation.startsWith(process.cwd())) {
    await rmdir(path.join(cacheLocation, "node_modules"));
    return cacheLocation;
  } else {
    const storeLocation = path.join(".package_store", hashMap.get(name).replace(/\//g, "_"));
    await copyDir(cacheLocation, storeLocation);
    return storeLocation;
  }
}

function extractPackageName(packageId: string): string {
  const rootPackage = packageId.split("+")[0];
  // We dismiss the first @ when the package start by an @
  const atIndex = rootPackage.slice(1).indexOf("@") + 1;
  return rootPackage.substr(0, atIndex);
}

(async () => {
  const installLocations = new Map(await Promise.all(nodes.filter(n => n !== "root").map<Promise<[string, string]>>(async n => {
    const cacheLocation = locationMap.get(n.split("+")[0]).replace("/package.json","");
    const location = await getInstallLocation(cacheLocation, n);
    return [n, location];
  })));

  await Promise.all(nodes.filter(n => n !== "root").map(async node => {
    const installLocation = installLocations.get(node);
    const dependencies = linksMap.get(node);
    await rmdir(path.join(installLocation, "node_modules", ".bin"));
    await mkdir(path.join(installLocation, "node_modules", ".bin"));
    await Promise.all(dependencies.concat(node).map(async d => {
      const dependencyLocation = installLocations.get(d);
      const depName = extractPackageName(d);
      const destination = path.join(installLocation, "node_modules", depName);
      // the link is already created. This is possible due to peerDependency resolution creating
      // duplicate packages having the same hash.
      if ((await realpath(destination)) === destination) {
        return;
      }
      await mkdir(path.dirname(destination));
      try {
        await symlink(path.relative(path.dirname(destination), dependencyLocation), destination);
      } catch (e) {
        // This symlink already exists but is pointing to a different package hash.
        // This should throw a warning in the peer-dependency resolution code.
        return;
      }
      const bin = require(path.resolve(process.cwd(), path.join(dependencyLocation, "package.json"))).bin;
      const formattedBin = typeof bin == "string" ? { [depName.includes("/") ? depName.split("/")[1] : depName]: bin } : bin || {};

      await Promise.all(Object.keys(formattedBin).map(async key => {
        try {
        await symlink(path.relative(path.join(installLocation, "node_modules", ".bin"), path.join(dependencyLocation, formattedBin[key])), path.join(installLocation, "node_modules", ".bin", key))
        } catch (e) {
          // the binary has already been provided by a dependency, ignoring
          // this happens for install when jest and jest-cli both provide the same bin
          // In this case it does not matter which one we pick because one is forwarding us to the other
        }
      }));

    }));
    try {
    const scripts = require(path.resolve(process.cwd(), path.join(installLocation, "package.json"))).scripts;
    if (scripts && scripts.postinstall) {
      await new Promise((resolve, reject) => {
        const c = child_process.spawn("yarn", ["postinstall"], { cwd: installLocation });
        c.on("exit", (code) => { code === 0 ? resolve() : reject("postinstall script failed") });

      })
    }
    } catch (e) {
      console.log(e);
    }
  }))

})()
