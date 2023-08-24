import fs from 'fs'
import ical from 'ical-generator'
import axios from 'axios'
import Handlebars from 'handlebars'
import { JSDOM } from 'jsdom'
import getCfkKey from './get-cfk-key.util'
import decipher from './decipher.util'

const ICALS_FOLDER = './icals'

/**
 * @param {import('express').Request<{}, any, any, QueryType, Record<string, any>>} req Request
 * @param {import('express').Response<any, Record<string, any>, number>} res Result
 * @returns {Promise<any>} Returns
 */
export default async function getIcs(req, res) {
    const { url, title } = req.query

    if (!url)
        return res.send(Handlebars.compile(fs.readFileSync('./src/templates/index.template.html').toString())())

    try {
        const equipeId = /\/equipe-([^)]+)\//gm.exec(url)[1]

        const fileName = `${ICALS_FOLDER}/${equipeId}.json`

        // Read from cache, if file was created 1h ago max. That way, we can prevent spamming FFHB website
        if (fs.existsSync(fileName) && Math.abs(fs.statSync(fileName).birthtime.getTime() - new Date().getTime()) / 36e5 < 1) {
            const json = fs.readFileSync(fileName)?.toString()

            if (json)
                return ical(JSON.parse(json)).serve(res)
        }

        const urlCompetition = url.replace(/\/$/, '').split('/').at(-2)

        const { data: dataRencontreListData } = await axios.request({
            url: 'https://www.ffhandball.fr/wp-json/competitions/v1/computeBlockAttributes',
            method: 'GET',
            params: {
                block: 'competitions---rencontre-list',
                url_competition: urlCompetition,
                ext_equipe_id: equipeId,
            },
        })

        const cfkKey = await getCfkKey()

        const rencontreList = /** @type {FfhbApiCompetitionListResult} */(decipher(dataRencontreListData, cfkKey))

        if (rencontreList.rencontres?.length === 0)
            throw new Error(`Aucune rencontres n'a été trouvé pour l'URL ${url} `)

        /** Addresses (and more?) are scraped because they are no longer inside the API returns. And no others API seems to be available for these data */
        const details = await Promise.allSettled(
            rencontreList.rencontres.map(async rencontre => {
                const baseUrl = url.replace(/\/$/, '').split('/').slice(0, -1).join('/')
                const rencontreUrl = `${baseUrl}/poule-${rencontreList.poule.ext_pouleId}/rencontre-${rencontre.ext_rencontreId}`

                const { data: addressData } = await axios.request({ url: rencontreUrl })
                const { document } = (new JSDOM(addressData)).window

                /** @type {FfhbApiAddressResult} */
                const address = JSON.parse(document.querySelector('smartfire-component[name="competitions---rencontre-salle"]').getAttribute('attributes'))

                return { address }
            }),
        )

        const events = rencontreList.rencontres
            .map((rencontre, i) => {
                if (!rencontre.date)
                    return null

                const dtStart = new Date(rencontre.date)
                const dtEnd = new Date(dtStart.getTime() + (1.5 * 60 * 60 * 1000))

                const status = (() => {
                    if (!rencontre.equipe1Score || !rencontre.equipe2Score)
                        return ''
                    const isTeamOne = rencontre.equipe1Libelle?.toLowerCase()?.trim() === rencontreList.poule.libelle?.toLowerCase()?.trim()
                    const teamOneScore = !Number.isNaN(parseInt(rencontre.equipe1Score, 10)) ? (parseInt(rencontre.equipe1Score, 10)) : 0
                    const teamTwoScore = !Number.isNaN(parseInt(rencontre.equipe2Score, 10)) ? (parseInt(rencontre.equipe2Score, 10)) : 0
                    if (isTeamOne ? teamOneScore > teamTwoScore : teamOneScore < teamTwoScore)
                        return '✅'
                    if (!isTeamOne ? teamOneScore > teamTwoScore : teamOneScore < teamTwoScore)
                        return '❌'
                    return '🟠'
                })()

                const fileCode = rencontre.fdmCode?.split('') ?? []
                const fileUrl = fileCode?.length >= 4
                    ? `https://media-ffhb-fdm.ffhandball.fr/fdm/${fileCode[0]}/${fileCode[1]}/${fileCode[2]}/${fileCode[3]}/${rencontre.fdmCode}.pdf`
                    : null

                const referees = [
                    rencontre.arbitre1,
                    rencontre.arbitre2,
                ].filter(x => x) ?? []

                const locations = (() => {
                    const adress = details[i]
                    if (adress.status === 'fulfilled')
                        return adress.value.address
                    return /** @type {FfhbApiAddressResult} */({})
                })()

                return /** @type {import('ical-generator').ICalEventData} */({
                    location: [
                        locations.equipement?.libelle,
                        locations.equipement?.rue,
                        locations.equipement?.ville,
                    ].map(location => location?.trim()).filter(x => !!x).join(', ').toUpperCase(),
                    description: [
                        rencontre.equipe1Score && rencontre.equipe2Score
                            ? `${status} Score : ${rencontre.equipe1Score} - ${rencontre.equipe2Score}`
                            : '👉 À venir',
                        fileUrl ? `🔗 ${fileUrl.replace('https://', '')}` : null,
                        referees?.length ? `🧑‍⚖️ ${new Intl.ListFormat('fr-FR', { style: 'long', type: 'conjunction' }).format(referees)}` : null,
                    ].filter(x => x).join('\n'),
                    start: dtStart,
                    end: dtEnd,
                    summary: `J.${rencontre.journeeNumero} : ${rencontre.equipe1Libelle || '?'} vs ${rencontre.equipe2Libelle || '?'}`,
                    url,
                    attachments: fileUrl ? [fileUrl] : undefined,
                })
            }).filter(x => x)

        /** @type {FfhbApiJourneesResult} */
        const journees = JSON.parse(rencontreList.poule.journees)

        /** @type {import('ical-generator').ICalCalendarData['name']} */
        let name = title || rencontreList.poule.libelle || ''

        // Add years if possible
        if (journees?.[0]?.date_debut || journees?.at(-1)?.date_debut)
            name += ` (${[
                new Date(journees?.[0]?.date_debut)?.getFullYear(),
                new Date(journees?.at(-1)?.date_debut)?.getFullYear(),
            ].filter((value, index, self) => value && self.indexOf(value) === index).join(' - ')})`

        const cal = ical({
            timezone: 'Europe/Paris',
            name,
            events,
        })

        // Save to cache
        if (!fs.existsSync(ICALS_FOLDER))
            fs.mkdirSync(ICALS_FOLDER)
        fs.writeFileSync(fileName, JSON.stringify(cal))

        return cal.serve(res)
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error(error)
        return res.status(400).send(`
            <p>Une erreur est survenue : <i>${error.message}</i></p>
            <p>Veuillez vérifier que le lien fourni respecte bien <a href="/" target="_blank">les conditions</a> :
            <a href={${url}} target="_blank">${url}</a>.</p>
            <p>Vous pouvez également contacter un administrateur du site.</p>
        `)
    }
}
