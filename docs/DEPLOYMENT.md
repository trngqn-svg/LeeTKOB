# LeeTKOB deployment: the VM

This file says what machine LeeTKOB runs on and how it is set up. It is the plan for PA#3. **The VM exists since 2026-11-24** and team members can log in over SSH, but its region, size and setup are not written here yet (task Q1), and Docker and the services of section 4 are not installed yet as far as the repository shows. Several numbers below must be checked in the Azure portal before anyone relies on them (section 8). Choosing Azure is decision 15 in `docs/DECISIONS.md`, and it is only proposed.

Why one machine: the PA#3 rubric asks for a public deployment that stays up until the PA#4 marks are out. The judge worker starts Docker containers, so the host must give it Docker. The API, the worker and the SQLite file run on the same host (`docs/ARCHITECTURE.md`, section 2.3).

## 1. The VM

| Setting                     | Value                                                                                            | Why                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Subscription                | Azure for Students                                                                               | The credit has a spending limit, so it cannot run up a bill (verify in the portal)  |
| Resource group              | `rg-leetkob`, with nothing else in it                                                            | Deleting the group at the end removes everything                                    |
| Region                      | **Korea Central.** Not East Asia: the Gemini API refuses calls from Hong Kong (section 7.1)      | The model API only serves some regions. Latency matters little here                 |
| Image                       | Ubuntu Server 24.04 LTS, x64 (22.04 LTS is also fine)                                            | Docker supports it, and it uses cgroup v2 for the memory and process limits         |
| Size for PA#3               | 2 vCPU and 4 GiB, for example `Standard_B2s` or the cheapest equivalent your subscription offers | Enough for one or two sandbox runs at a time. It is burstable, see "Why this size"  |
| Size for the PA#5 load test | 4 vCPU and 8 GiB, not burstable, for example `Standard_D4s_v5`, for a few days only              | 80 submissions at once need steady CPU. Resizing restarts the VM                    |
| OS disk                     | 64 GiB Standard SSD                                                                              | Docker images (Node, g++), logs and the SQLite file. The default 30 GiB can fill up |
| Swap                        | None, which is the Azure default. Check with `free -h`                                           | With no swap the memory limit of a sandbox run is simple: the limit is the limit    |
| Public IP                   | Standard SKU, static, with a DNS name label (`NAME.REGION.cloudapp.azure.com`)                   | A stable address for `PA3.md`, and no domain to buy                                 |
| Login                       | SSH key only. No password, no root login                                                         | A password login on a public IP is attacked within minutes                          |
| Identity                    | None. No managed identity and no Azure role for the VM                                           | If a sandbox ever escaped, it would find no way into your Azure subscription        |
| Auto-shutdown               | Off                                                                                              | The deployment must stay up until the PA#4 marks are out                            |
| Boot diagnostics            | On, with managed storage                                                                         | Gives a console when SSH is broken                                                  |
| Monitoring                  | Basic metrics, plus an outside check of `/health` every few minutes                              | Tells you before the lecturer does                                                  |

### Why this size

A rough memory budget, as estimates to be measured on the real VM: the operating system and Docker about 0.7 GiB, the API and the worker about 0.3 GiB together, Caddy under 0.1 GiB, and one sandbox run up to 0.5 GiB at the largest lab limit (FAQ-05) plus up to about 0.3 GiB for the compiler. That is under 2 GiB with one run at a time, so 4 GiB leaves room for two runs and for Docker's file cache.

The CPU is the real limit. A burstable size (the B series) earns CPU credits while it is idle and spends them under load. When they run out, the VM is slowed to a baseline share of the CPU. Compiling C++ for every submission, and the PA#5 load test with 80 submissions at once, are sustained load. A slowed CPU can push a test past its wall-time limit (3 times the CPU limit, FAQ-05) and cause false time-limit results. So a burstable size is fine for PA#3, but watch the CPU credit balance in the portal, and use a size that is not burstable for the load test.

## 2. Network

Inbound rules of the network security group:

| Priority              | Direction | Port | Source                  | Action                                         |
| --------------------- | --------- | ---- | ----------------------- | ---------------------------------------------- |
| 100                   | Inbound   | 443  | Any                     | Allow                                          |
| 110                   | Inbound   | 80   | Any                     | Allow (the certificate, and a redirect to 443) |
| 120                   | Inbound   | 22   | Your own public IP only | Allow                                          |
| 65500, a default rule | Inbound   | Any  | Any                     | Deny                                           |

Outbound stays open, so that the worker can reach the model API over HTTPS and the VM can fetch updates and images. Sandbox containers have no network at all, whatever the VM allows.

## 3. Software on the VM

- Docker Engine and the Compose plugin, from Docker's own apt repository (not the distribution's older package).
- Caddy, as a container in the same Compose file, for automatic HTTPS on the DNS name.
- `git`, to fetch the repository, and the `sqlite3` command line, to look at the database and to make a backup copy.
- Automatic security updates (`unattended-upgrades`). Do not let it reboot the VM by itself during grading. Services restart after a reboot because every service is set to restart unless it was stopped on purpose.
- No Node.js on the host. The app runs in its container.

## 4. How it runs

| Service  | What it is                                               | Ports                                     | Volumes                                  | Secrets                       | Notes                                                                                                       |
| -------- | -------------------------------------------------------- | ----------------------------------------- | ---------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `caddy`  | A container                                              | 80 and 443, published                     | Its own volume for certificates          | None                          | Ends HTTPS and forwards to `api`. The only service the internet can reach                                   |
| `api`    | A container of the app image, entry `src/server.ts`      | 3000, on the internal Docker network only | `data` at `/data`                        | None (no model key)           | Reads and writes the SQLite file. No Docker access                                                          |
| `worker` | A container of the same image, entry `src/worker.ts`     | None                                      | `data` at `/data`, and the Docker socket | `LLM_API_KEY` and `LLM_MODEL` | Starts the sandbox containers. The socket is root on the host, so the worker accepts no inbound connection  |
| sandbox  | One short-lived container per run, started by the worker | None                                      | None                                     | None                          | No network, memory and process limits, non-root, read-only, no mounts (`docs/ARCHITECTURE.md`, section 2.3) |

The Compose file and the Dockerfile for the app image come in a pull request of their own (task Q4 in `docs/TASKS.md`). Both the API and the worker open the same SQLite file through the shared `data` volume. This works because both containers run on the same host, in WAL mode (`docs/ARCHITECTURE.md`, section 3). It would not work over a network file system.

## 5. Secrets and access

- `LLM_API_KEY` and `LLM_MODEL` live in a file owned by root, which Docker Compose reads for the worker only. They are not given to the API, never to a sandbox container, never put in an image and never committed.
- A user in the `docker` group is as powerful as root on the VM, so only teammates you trust get that group.
- Each teammate gets their own SSH key on the VM, not a shared private key. The owner of the subscription should also give the teammates access to the resource group, if a student subscription allows it, so that one person being away does not lock the team out.
- The test accounts in `PA3.md` hold no real data. Anyone who reads the repository can use them, so the model quota is the spending cap (decision 6).
- Nothing else of yours goes on this VM: no personal keys, no other projects, and no Azure identity.

## 6. Cost and credit

- The costs are the VM, the OS disk, the public IP and the traffic. As far as I know, a 2 vCPU and 4 GiB Linux VM of the B class costs in the order of tens of US dollars a month. The 4 vCPU size that is not burstable costs more per day, but it is needed for a few days only. Check both in the Azure pricing calculator for your region.
- Set budget alerts at 50 and 80 percent of the credit in Cost Management, and look at the remaining credit when you create the VM. Confirm whether the subscription is switched off when the credit ends: if it is, the deployment dies at that moment.
- The VM has to run from the PA#3 deadline until the PA#4 marks are out, a few weeks. Stopping it saves money but takes the deployment down, so it is not an option in that time.

## 7. Checks to run on the new VM

Run these on the VM before anything is deployed:

```bash
# Expect cgroup2fs: the memory and process limits of the sandbox rely on cgroup v2.
stat -fc %T /sys/fs/cgroup

# Expect Swap: 0B.
free -h

# Docker works.
docker run --rm hello-world

# A container without network and with a memory limit that includes swap starts.
docker run --rm --network none --memory 64m --memory-swap 64m alpine echo ok

# Expect 67108864, the limit as the kernel sees it.
docker run --rm --memory 64m alpine cat /sys/fs/cgroup/memory.max
```

## 7.1 Deploy and update

The public name is `leetkob-hcmus.koreacentral.cloudapp.azure.com` (the DNS label of the public IP). Ports 80 and 443 are open in the network security group; Caddy gets the certificate from Let's Encrypt by itself on the first start. On 2026-11-26 the stack was tried on a first VM under another project name: `/health` answered 200 over HTTPS from the internet, plain HTTP redirected to HTTPS, and port 3000 could not be reached from outside. The trial was then removed with its volumes.

**The VM moved on 2026-11-27.** The first VM was in East Asia (Hong Kong). With the worker running there, the first real submission got `unsure` with reason `model_error` on every semantic constraint, because Gemini answered HTTP 400 `FAILED_PRECONDITION: User location is not supported for the API use.` Hong Kong is not in Google's list of supported regions (Singapore, Japan, South Korea, Vietnam, India and the United States are). The VM was recreated in Korea Central (Ubuntu 24.04, 2 vCPU, about 3.8 GiB of memory). There, a call to the model answered 200, and six dev-set solutions of one problem were judged `accepted` with all 12 constraint verdicts equal to the lecturer's labels. A move to another region needs the same check: call the model from the new VM before deploying.

First time, from the clone of the repository on the VM:

```bash
# The settings file, readable by root only. Fill in SEED_PASSWORD, LLM_API_KEY, LLM_MODEL
# and DOCKER_GID (getent group docker | cut -d: -f3) with an editor run as root.
sudo install -D --mode 600 --owner root deploy/leetkob.env.example /etc/leetkob/leetkob.env

# The sandbox image the worker starts containers from, then the stack.
sudo docker build --tag leetkob-sandbox docker/sandbox
sudo docker compose --env-file /etc/leetkob/leetkob.env --file deploy/compose.yaml up --detach --build
```

The worker is in the Compose profile `worker`, so add `--profile worker` to the last command (before `up`) to start it. It stops at start with a message if `LLM_API_KEY` or `LLM_MODEL` is empty and `MODEL_OFF` is not `1`.

To update: `git pull`, rebuild the sandbox image if `docker/sandbox/` changed, and run the last command again. The `data` volume keeps the database; the API applies new migrations and resets the test accounts' password to `SEED_PASSWORD` when it starts.

To look: `sudo docker compose --file deploy/compose.yaml ps`, and `logs --tail 100 api` (or `caddy`, `worker`).

## 8. What to verify before relying on this

- Is the Azure for Students credit active for the `@student.hcmus.edu.vn` account?
- Which regions and which VM sizes does the subscription allow? Try creating the VM first, in a few regions.
- Is the subscription switched off when the credit ends, and for how long is the credit valid?
- Does the B-series CPU slow down under the compile load? Watch the CPU credit metric during a test run.
- Do the checks of section 7 give the expected results, and does the 1 GiB memory attack of the nine sandbox tests meet the limit on this VM, not only in CI?
- Can teammates be given access to the subscription or the resource group?

## 9. At the end of the course

Delete the resource group `rg-leetkob`. That removes the VM, the disk and the public IP, and stops every cost.
