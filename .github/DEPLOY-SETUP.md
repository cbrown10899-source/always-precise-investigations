# One-time setup: automatic deploys

After this, every change pushed to the repo deploys to
alwayspreciseinvestigations.net by itself — no zip dragging.

You do ONE thing: give GitHub a Cloudflare token so it's allowed to deploy.

## 1. Create the Cloudflare API token (~2 min)
1. Cloudflare dashboard → your profile (top-right) → **My Profile** → **API Tokens**
   (or go to dash.cloudflare.com/profile/api-tokens)
2. **Create Token** → use the **"Edit Cloudflare Workers"** template
   (it includes Pages), OR **Create Custom Token** with these permissions:
   - **Account** → **Cloudflare Pages** → **Edit**
3. Under "Account Resources" pick **Corlinllc@gmail.com's Account**
4. **Continue to summary** → **Create Token**
5. **Copy the token** (you only see it once)

## 2. Add it to the GitHub repo (~1 min)
1. Go to: github.com/cbrown10899-source/always-precise-investigations
2. **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
3. Name: `CLOUDFLARE_API_TOKEN`
4. Value: paste the token → **Add secret**

## 3. Trigger the first deploy
- Either push any change, or:
- Repo → **Actions** tab → **Deploy site to Cloudflare Pages** → **Run workflow**
- Watch it go green. Then check the site.

## If the first deploy lands as a "Preview" instead of Production
Cloudflare Pages → always-precise → **Settings** → **Builds & deployments** →
set the **Production branch** to `main`. Re-run the workflow.

## From then on
Tell Claude "deploy X" → it commits and pushes → this Action deploys it live in
about a minute. That's the whole loop.
