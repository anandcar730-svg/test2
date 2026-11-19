# Put Fleet Driver Monitor on Oracle Cloud (free)

This guide runs the **server version** on Oracle Cloud's **Always Free** virtual machine. All drivers' phones then share one database automatically, with no backup files to send. You get a free HTTPS address such as `https://140-238-1-2.sslip.io`, or you can use your own domain.

You need about 20 minutes, and a card for Oracle's identity check. The free tier does not charge it.

---

## 1. Create an Oracle Cloud account
1. Go to **oracle.com/cloud/free** and click **Start for free**.
2. Choose a **Home Region** close to your drivers, such as *India South (Hyderabad)* or *India West (Mumbai)*. You can't change it later.
3. Finish the sign-up and log in to the **OCI Console**.

## 2. Create the virtual machine
1. Open the menu ☰, then **Compute → Instances → Create instance**.
2. **Name:** `fleet-server`
3. **Image and shape → Edit:**
   - **Image:** click *Change image* and pick **Canonical Ubuntu 24.04** (or 22.04).
   - **Shape:** click *Change shape* and choose one of these:
     - **Ampere → VM.Standard.A1.Flex**, with 1 OCPU and 6 GB memory. This is the best free option.
     - or **VM.Standard.E2.1.Micro**, which is also free and is enough for a small fleet.
   - If you get *"Out of capacity"*, try another *Availability domain* or try again later.
4. **Networking:** keep the defaults (new VCN, public subnet), and make sure **Assign a public IPv4 address** is ticked.
5. **Add SSH keys:** click **Save private key** and keep the downloaded `.key` file safe.
6. Click **Create**. When it shows *Running*, copy the **Public IP address**.

## 3. Open ports 80 and 443 in Oracle's network
1. On the instance page, click the **Subnet** link, then **Security Lists**, then **Default Security List**.
2. Click **Add Ingress Rules** and add two rules:

| Source CIDR | IP Protocol | Destination Port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

Port 22 (SSH) is already open by default.

## 4. Copy the app to the server
On your computer, open a terminal (Windows: PowerShell) in the folder where `fleet-app.zip` and the `.key` file are:

```bash
# Windows PowerShell: if ssh complains about key permissions, see the note below
chmod 600 ssh-key.key                         # macOS / Linux only
scp -i ssh-key.key fleet-app.zip ubuntu@YOUR_PUBLIC_IP:~
ssh -i ssh-key.key ubuntu@YOUR_PUBLIC_IP
```

Windows key-permission note: right-click the key → Properties → Security → Advanced → Disable inheritance → remove all users except yourself.

If the code is on GitHub, you can run `git clone https://github.com/<you>/test2.git` on the server instead.

## 5. Run the setup script (on the server)
```bash
sudo apt-get install -y unzip
unzip fleet-app.zip
cd fleet-app
sudo bash deploy/oracle-setup.sh
```

The script installs everything and prints something like this at the end:

```
Open       : https://140-238-1-2.sslip.io
Login      : admin
Password   : Xk3f9Qa2LmP7
```

**Write the password down.** It is shown only once. Open the link, log in, and change it on the **Profile** page. Then add your vehicles and drivers, and share the link with your drivers. On a phone, use the browser menu → **Add to Home screen** to make it work like an app.

### Using your own domain (optional)
Example: `driver-log.shalomchurch.co.in`.

1. At your domain provider's DNS settings for `shalomchurch.co.in`, add this record:

   | Type | Name / Host | Value / Points to | TTL |
   |---|---|---|---|
   | A | `driver-log` | `YOUR_PUBLIC_IP` | 600 (or default) |

   Use a **hyphen (`-`), not an underscore (`_`)**. Web addresses can't contain underscores, and no HTTPS certificate can be issued for them. `driverlog` (no separator) also works.
2. Wait 5–30 minutes. Check the record with `nslookup driver-log.shalomchurch.co.in`; it should show your server's IP.
3. Run on the server:
   ```bash
   cd ~/fleet-app && sudo bash deploy/oracle-setup.sh driver-log.shalomchurch.co.in
   ```
   The script warns you if the domain doesn't point to the server yet. HTTPS starts working automatically once it does.

---

## Everyday commands (on the server)
| Task | Command |
|---|---|
| Is it running? | `sudo systemctl status fleet-app` |
| Live logs | `sudo journalctl -u fleet-app -f` |
| HTTPS certificate logs | `sudo journalctl -u caddy -f` |
| Restart | `sudo systemctl restart fleet-app` |
| Backups (made daily, kept 14 days) | `ls /var/backups/fleet` |
| Download a backup to your computer | `scp -i ssh-key.key -r ubuntu@YOUR_PUBLIC_IP:/var/backups/fleet ./fleet-backups` |

**Updating the app:** copy the new `fleet-app` folder to the server and run `sudo bash deploy/oracle-setup.sh` again. Your data (`/var/lib/fleet`) and admin password are kept.

**Restoring a backup:**
```bash
sudo systemctl stop fleet-app
sudo cp /var/backups/fleet/fleet-YYYY-MM-DD.db /var/lib/fleet/fleet.db
sudo rm -f /var/lib/fleet/fleet.db-wal /var/lib/fleet/fleet.db-shm
sudo tar -xzf /var/backups/fleet/uploads-YYYY-MM-DD.tar.gz -C /var/lib/fleet
sudo chown -R fleet:fleet /var/lib/fleet && sudo systemctl start fleet-app
```

## Troubleshooting
- **The page doesn't open:**
  - Check that the two Ingress Rules from step 3 exist.
  - Check that the app is running: `sudo systemctl status fleet-app`.
  - Run `curl -I http://127.0.0.1:3000` on the server.
- **"Your connection is not private" or a certificate error:** Caddy is still getting the certificate, or ports 80/443 are blocked. Check `sudo journalctl -u caddy -n 50`.
- **Oracle stopped my VM:** Oracle may reclaim *idle* Always Free instances. Upgrading the account to **Pay-As-You-Go** stops that, and you still pay nothing as long as you stay within the free limits.
- **Make off-server copies too.** Download the backups now and then (command above). The daily backups protect against mistakes, but they sit on the same server, so they don't protect against losing the server.

## Using Cloudflare (orange cloud / "Proxied")
Error **526 Invalid SSL certificate** means Cloudflare couldn't verify the certificate on the server. Pick one of these fixes.

**Option A (simplest): DNS only.** Turn Cloudflare's proxy off for this record.
1. In Cloudflare, go to **DNS → Records**, edit `driver-log`, and switch it to **DNS only** (grey cloud).
2. Wait 2 minutes, then on the server run `sudo systemctl restart caddy`.
3. Caddy gets a free Let's Encrypt certificate and renews it by itself.

**Option B: keep the orange cloud.** Use a Cloudflare Origin Certificate.
1. In Cloudflare, go to **SSL/TLS → Origin Server → Create Certificate**. Keep the defaults (RSA, hostnames `*.shalomchurch.co.in` and `shalomchurch.co.in`, 15 years) and click **Create**.
2. On the server, paste the two text boxes into these files:
   ```bash
   sudo mkdir -p /etc/caddy
   sudo nano /etc/caddy/cloudflare-origin.pem   # paste "Origin Certificate", save with Ctrl+O, Enter, Ctrl+X
   sudo nano /etc/caddy/cloudflare-origin.key   # paste "Private Key", save the same way
   ```
3. Run the setup again:
   `cd ~/fleet-app && sudo bash deploy/oracle-setup.sh driver-log.shalomchurch.co.in`
4. In Cloudflare, go to **SSL/TLS → Overview** and set the mode to **Full (strict)**.

Cloudflare limits uploads to 100 MB on the free plan. Photos from the app are compressed to well under that.
